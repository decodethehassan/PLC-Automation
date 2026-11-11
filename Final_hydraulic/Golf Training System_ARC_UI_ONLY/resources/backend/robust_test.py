#!/usr/bin/env python3
import time
import json
import threading
import socket
import struct
import queue
from datetime import datetime
from flask import Flask, render_template, request, jsonify
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional
import sqlite3
from contextlib import contextmanager
from urllib.parse import unquote


# PLC Configuration (PRODUCTION)
PLC_HOST = '192.168.68.8'
CLIENT_HOST = '192.168.68.10'

PLC_PORT = 5000
CLIENT_PORT = 20000


@dataclass
class SwingResult:
    swing_number: int
    max_speed: float
    avg_torque: float
    duration: float
    smoothness: float
    score: float
    timestamp: str


@dataclass
class TrainingSession:
    user_name: str
    start_time: str
    end_time: Optional[str]
    date: str
    hand_preference: str
    back_swing_mode: str
    resistance_back: int
    resistance_forward: int
    starting_angle: int
    power_status: str
    swings: List[SwingResult]
    best_score: float
    total_swings: int
    how_many_target: int
    highest_level_target: int


class PLCManager:
    def __init__(self):
        self.socket = None
        self.connected = False
        self.running = False
        self.current_position = 0.0
        self.receive_thread = None
        self.current_mode = 'none'
        self.power_on = False
        self.motor_running = False
        self.lock = threading.Lock()
        self.training_system = None
        self.hand_command_queue: "queue.Queue[tuple]" = queue.Queue()
        self.hand_worker = threading.Thread(target=self._hand_command_worker, daemon=True)
        self.hand_worker.start()

    def connect(self):
        try:
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

            try:
                self.socket.bind((CLIENT_HOST, CLIENT_PORT))
            except OSError as e:
                if "10049" in str(e) or "not valid" in str(e).lower():
                    self.socket.bind(('0.0.0.0', CLIENT_PORT))
                else:
                    raise

            self.socket.settimeout(3.0)
            self.socket.connect((PLC_HOST, PLC_PORT))
            self.socket.settimeout(None)

            self.connected = True
            self.running = True

            self.receive_thread = threading.Thread(target=self._receive_loop, daemon=True)
            self.receive_thread.start()

            return True

        except socket.error:
            self.connected = False
            return False

    def disconnect(self):
        self.running = False
        if self.socket:
            try:
                self.socket.close()
            except Exception:
                pass
        self.connected = False

    def send_command(self, command_id: int, value: int):
        if not self.connected:
            return False

        try:
            with self.lock:
                value = int(value)

                if value < 0:
                    message = struct.pack('<Bh', command_id, value)
                else:
                    message = struct.pack('<BH', command_id, value)

                self.socket.sendall(message)
                time.sleep(0.02)

            return True

        except socket.error:
            self.connected = False
            return False
        except Exception:
            return False

    def set_mode(self, mode: str):
        mode_map = {
            'neutral': 1,
            'assist': 2,
            'resistance': 3,
            'reference': 4,
            'retro': 1
        }

        if mode not in mode_map:
            return False

        self.current_mode = mode
        success = self.send_command(9, mode_map[mode])

        if success:
            if mode == 'assist':
                time.sleep(0.02)
                self.set_backswing_resistance(0)

        return success

    def set_reference_angle(self, angle: int, channel: str = 'primary'):
        plc_value = round(angle * 2.25)

        if channel == 'secondary':
            success = self.send_command(50, plc_value)
        else:
            success = self.send_command(25, plc_value)

        return success

    def set_retro_settings(self, back_resistance: int, angle: int, channel: str = 'primary'):
        success_back = self.set_backswing_resistance(back_resistance)
        time.sleep(0.02)

        plc_value = round(angle * 2.25)

        if channel == 'secondary':
            success_angle = self.send_command(50, plc_value)
        else:
            success_angle = self.send_command(25, plc_value)

        return success_back and success_angle

    def set_power(self, on: bool):
        value = 1 if on else 0
        success = self.send_command(1, value)

        if success:
            self.power_on = on

        return success

    def start_stop_motor(self, start: bool):
        value = 1 if start else 0
        success = self.send_command(2, value)

        if success:
            self.motor_running = start

        return success

    def scale_resistance_to_plc(self, percent: int) -> int:
        """
        Client requested new resistance scaling.

        Previous behavior:
            30% UI approximately produced PLC value 910.

        New behavior:
            100% UI should produce PLC value 910.

        New scale:
            0%   -> 10
            5%   -> 55
            10%  -> 100
            30%  -> 280
            50%  -> 460
            100% -> 910

        Applies to both backswing and forward swing.
        """
        try:
            percent = int(percent)
        except (TypeError, ValueError):
            percent = 0

        percent = max(0, min(100, percent))

        plc_value = round(10 + (900 * (percent / 100)))
        return plc_value

    def set_backswing_resistance(self, percent: int):
        plc_value = self.scale_resistance_to_plc(percent)
        return self.send_command(10, plc_value)

    def set_forward_resistance(self, percent: int):
        plc_value = self.scale_resistance_to_plc(percent)
        return self.send_command(11, plc_value)


    def set_resistance_pair(self, back_percent: int, forward_percent: int, assist_mode: bool = False):
        """
        Send forward (command 11) and back (command 10) as ONE locked transaction.

        This prevents two concurrent /resistance HTTP requests from interleaving like:
            FWD-old, FWD-new, BACK-old, BACK-new
        which can create a short torque transient/hump.
        """
        if not self.connected or not self.socket:
            return False

        try:
            back_percent = max(0, min(100, int(back_percent)))
        except (TypeError, ValueError):
            back_percent = 0

        try:
            forward_percent = max(0, min(100, int(forward_percent)))
        except (TypeError, ValueError):
            forward_percent = 0

        if assist_mode:
            back_percent = 0

        forward_value = self.scale_resistance_to_plc(forward_percent)
        back_value = self.scale_resistance_to_plc(back_percent)

        try:
            with self.lock:
                self.socket.sendall(struct.pack('<BH', 11, int(forward_value)))
                time.sleep(0.02)
                self.socket.sendall(struct.pack('<BH', 10, int(back_value)))
                time.sleep(0.02)
            return True
        except socket.error:
            self.connected = False
            return False
        except Exception:
            return False

    def set_reference(self, value: int = 1):
        return self.send_command(12, value)

    def set_hand_preference(self, command_id: int, value: int):
        if not self.connected:
            return False

        result_event = threading.Event()
        result_container = {'success': False}

        self.hand_command_queue.put((command_id, value, result_container, result_event))

        completed = result_event.wait(timeout=2.0)
        if not completed:
            return False

        return result_container['success']

    def _receive_loop(self):
        while self.running:
            try:
                data = self.socket.recv(8)

                if not data:
                    self.running = False
                    self.connected = False
                    break

                if len(data) == 8:
                    position = struct.unpack('<d', data)[0]
                    previous_position = self.current_position
                    self.current_position = position

                    if self.training_system and self.training_system.training_active:
                        if previous_position < 5 and position >= 5:
                            self.training_system.position_cross_count += 1

                        self.training_system.was_below_5 = position < 5

            except socket.error:
                if self.running:
                    self.running = False
                    self.connected = False
                break

            except Exception:
                break

    def _hand_command_worker(self):
        while True:
            command_id, value, result_container, result_event = self.hand_command_queue.get()

            try:
                success = self.send_command(command_id, value)
                result_container['success'] = success
            except Exception:
                result_container['success'] = False
            finally:
                result_event.set()
                self.hand_command_queue.task_done()

    def get_status(self):
        return {
            'connected': self.connected,
            'position': round(self.current_position, 2),
            'mode': self.current_mode,
            'power_on': self.power_on,
            'motor_running': self.motor_running
        }


class DatabaseManager:
    def __init__(self, db_path: str = "golf_training.db"):
        self.db_path = db_path
        self.init_database()

    @contextmanager
    def get_connection(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row

        try:
            yield conn
            conn.commit()
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            conn.close()

    def init_database(self):
        with self.get_connection() as conn:
            cursor = conn.cursor()

            cursor.execute('''
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL,
                    created_at TEXT NOT NULL,
                    last_session_at TEXT,
                    total_sessions INTEGER DEFAULT 0,
                    best_score REAL DEFAULT 0.0,
                    avg_score REAL DEFAULT 0.0,
                    total_swings INTEGER DEFAULT 0,
                    preferred_hand TEXT,
                    preferred_back_swing_mode TEXT,
                    preferred_resistance_back INTEGER,
                    preferred_resistance_forward INTEGER,
                    preferred_starting_angle INTEGER
                )
            ''')

            cursor.execute('''
                CREATE TABLE IF NOT EXISTS sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_name TEXT NOT NULL,
                    start_time TEXT NOT NULL,
                    end_time TEXT,
                    session_date TEXT NOT NULL,
                    hand_preference TEXT,
                    back_swing_mode TEXT,
                    resistance_back TEXT,
                    resistance_forward TEXT,
                    starting_angle INTEGER,
                    power_status TEXT,
                    how_many_target INTEGER,
                    highest_level_target INTEGER,
                    total_swings INTEGER DEFAULT 0,
                    best_score REAL DEFAULT 0.0,
                    avg_score REAL DEFAULT 0.0,
                    duration_minutes REAL,
                    session_data TEXT,
                    FOREIGN KEY (user_name) REFERENCES users (name)
                )
            ''')

    def get_all_users(self) -> List[Dict]:
        with self.get_connection() as conn:
            cursor = conn.cursor()

            cursor.execute('''
                SELECT name, created_at, last_session_at, total_sessions,
                       best_score, avg_score, total_swings, preferred_hand,
                       preferred_back_swing_mode, preferred_resistance_back,
                       preferred_resistance_forward,
                       preferred_starting_angle
                FROM users
                ORDER BY last_session_at DESC, name ASC
            ''')

            return [dict(row) for row in cursor.fetchall()]

    def get_user_details(self, name: str) -> Optional[Dict]:
        with self.get_connection() as conn:
            cursor = conn.cursor()

            cursor.execute('SELECT * FROM users WHERE name = ?', (name,))
            user_row = cursor.fetchone()

            if not user_row:
                return None

            cursor.execute('''
                SELECT * FROM sessions
                WHERE user_name = ?
                ORDER BY start_time DESC
                LIMIT 20
            ''', (name,))

            sessions = [dict(row) for row in cursor.fetchall()]

            return {
                **dict(user_row),
                'recent_sessions': sessions
            }

    def get_or_create_user(self, name: str, hand_preference: str = None) -> Dict:
        with self.get_connection() as conn:
            cursor = conn.cursor()

            cursor.execute('SELECT * FROM users WHERE name = ?', (name,))
            user = cursor.fetchone()

            if user:
                if hand_preference:
                    cursor.execute(
                        'UPDATE users SET preferred_hand = ? WHERE name = ?',
                        (hand_preference, name)
                    )
                    conn.commit()

                    cursor.execute('SELECT * FROM users WHERE name = ?', (name,))
                    user = cursor.fetchone()

                return {**dict(user), 'is_new': False}

            hand_pref = hand_preference if hand_preference else 'right'

            cursor.execute('''
                INSERT INTO users (name, created_at, last_session_at, preferred_hand)
                VALUES (?, ?, ?, ?)
            ''', (
                name,
                datetime.now().isoformat(),
                datetime.now().isoformat(),
                hand_pref
            ))

            return {
                'name': name,
                'created_at': datetime.now().isoformat(),
                'total_sessions': 0,
                'best_score': 0.0,
                'avg_score': 0.0,
                'total_swings': 0,
                'is_new': True,
                'preferred_hand': hand_pref
            }

    def delete_user(self, name: str) -> bool:
        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute('DELETE FROM sessions WHERE user_name = ?', (name,))
                cursor.execute('DELETE FROM users WHERE name = ?', (name,))
                return cursor.rowcount > 0
        except Exception:
            return False

    def save_session(self, session: TrainingSession):
        with self.get_connection() as conn:
            cursor = conn.cursor()

            avg_score = (
                sum(s.score for s in session.swings) / len(session.swings)
                if session.swings else 0.0
            )

            duration_minutes = 0.0
            if session.end_time:
                start = datetime.fromisoformat(session.start_time)
                end = datetime.fromisoformat(session.end_time)
                duration_minutes = (end - start).total_seconds() / 60.0

            cursor.execute('''
                INSERT INTO sessions (
                    user_name, start_time, end_time, session_date, hand_preference,
                    back_swing_mode, resistance_back, resistance_forward,
                    starting_angle, power_status, how_many_target, highest_level_target,
                    total_swings, best_score, avg_score, duration_minutes, session_data
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                session.user_name,
                session.start_time,
                session.end_time,
                session.date,
                session.hand_preference,
                session.back_swing_mode,
                session.resistance_back,
                session.resistance_forward,
                session.starting_angle,
                session.power_status,
                session.how_many_target,
                session.highest_level_target,
                session.total_swings,
                session.best_score,
                avg_score,
                duration_minutes,
                json.dumps(asdict(session))
            ))

            cursor.execute('''
                UPDATE users SET
                    total_sessions = total_sessions + 1,
                    last_session_at = ?,
                    best_score = MAX(best_score, ?),
                    total_swings = total_swings + ?,
                    preferred_hand = ?,
                    preferred_back_swing_mode = ?,
                    preferred_resistance_back = ?,
                    preferred_resistance_forward = ?,
                    preferred_starting_angle = ?
                WHERE name = ?
            ''', (
                session.end_time or datetime.now().isoformat(),
                session.best_score,
                session.total_swings,
                session.hand_preference,
                session.back_swing_mode,
                session.resistance_back,
                session.resistance_forward,
                session.starting_angle,
                session.user_name
            ))


class GolfTrainingSystem:
    def __init__(self):
        self.plc = PLCManager()
        self.db = DatabaseManager()
        self.current_session: Optional[TrainingSession] = None
        self.training_active = False
        self.swing_count = 0
        self.best_score = 0.0
        self.position_cross_count = 0
        self.was_below_5 = True
        self.max_resistance = 0
        self.plc.training_system = self

    def start_training(self, config: Dict) -> Dict:
        try:
            user_data = self.db.get_or_create_user(config['name'])

            self.position_cross_count = 0
            self.was_below_5 = True
            self.max_resistance = max(config['resistance1'], config['resistance2'])

            self.current_session = TrainingSession(
                user_name=config['name'],
                start_time=datetime.now().isoformat(),
                end_time=None,
                date=config.get('date', datetime.now().strftime('%Y-%m-%d')),
                hand_preference=config['hand'],
                back_swing_mode=config.get('backSwingMode', 'neutral'),
                resistance_back=config['resistance1'],
                resistance_forward=config['resistance2'],
                starting_angle=config['angle'],
                power_status=config.get('power', 'ON'),
                how_many_target=0,
                highest_level_target=0,
                swings=[],
                best_score=0.0,
                total_swings=0
            )

            if not self.plc.connected:
                if not self.plc.connect():
                    return {
                        'status': 'error',
                        'message': 'Failed to connect to PLC',
                        'count': 0,
                        'successRate': "0%"
                    }

            time.sleep(0.05)
            self.plc.start_stop_motor(True)

            self.swing_count = 0
            self.best_score = user_data['best_score']
            self.training_active = True

            return {
                'status': 'success',
                'message': f"Training started for {config['name']}",
                'count': self.swing_count,
                'successRate': f"{self.best_score:.1f}%",
                'user_data': user_data
            }

        except Exception as e:
            import traceback
            traceback.print_exc()

            return {
                'status': 'error',
                'message': str(e),
                'count': 0,
                'successRate': "0%"
            }

    def stop_training(self) -> Dict:
        try:
            if self.plc.connected:
                self.plc.start_stop_motor(False)

            self.training_active = False

            if self.current_session:
                self.current_session.end_time = datetime.now().isoformat()
                self.current_session.total_swings = self.swing_count
                self.current_session.best_score = self.best_score
                self.current_session.how_many_target = self.position_cross_count
                self.current_session.highest_level_target = self.max_resistance

                self.db.save_session(self.current_session)

            return {
                'status': 'success',
                'message': f"Training stopped. {self.swing_count} swings completed.",
                'final_count': self.swing_count,
                'final_score': f"{self.best_score:.1f}%",
                'how_many_target': self.position_cross_count,
                'highest_level_target': self.max_resistance
            }

        except Exception as e:
            return {'status': 'error', 'message': str(e)}

    def get_current_status(self, include_session: bool = False) -> Dict:
        plc_status = self.plc.get_status()

        status = {
            'training_active': self.training_active,
            'swing_count': self.swing_count,
            'best_score': f"{self.best_score:.1f}%",
            'plc_connected': plc_status['connected'],
            'plc_position': plc_status['position'],
            'plc_mode': plc_status['mode'],
            'power_on': plc_status['power_on'],
            'motor_running': plc_status['motor_running']
        }

        if include_session and self.current_session:
            status['session'] = asdict(self.current_session)
        else:
            status['session'] = None

        return status

    def control_power(self, on: bool) -> Dict:
        success = self.plc.set_power(on)

        return {
            'status': 'success' if success else 'error',
            'power': 'ON' if on else 'OFF'
        }

    def set_mode_realtime(self, mode: str) -> Dict:
        success = self.plc.set_mode(mode)

        if not success:
            return {
                'status': 'error',
                'message': f'Failed to set mode to {mode}'
            }

        response_data = {
            'status': 'success',
            'message': f'Mode set to {mode.upper()}',
            'mode': mode,
            'back_resistance_reset': False
        }

        if mode == 'assist':
            response_data['back_resistance_reset'] = True
            response_data['message'] += ' (Back resistance set to 0)'

        return response_data

    def set_reference_angle_realtime(self, angle: int, channel: str = 'primary') -> Dict:
        success = self.plc.set_reference_angle(angle, channel=channel)

        if not success:
            return {
                'status': 'error',
                'message': f'Failed to set {channel} reference angle to {angle}°'
            }

        return {
            'status': 'success',
            'message': f'{channel.title()} reference angle set to {angle}°'
        }

    def update_resistance(self, back: int, forward: int) -> Dict:
        try:
            back = int(back)
        except (TypeError, ValueError):
            back = 0

        try:
            forward = int(forward)
        except (TypeError, ValueError):
            forward = 0

        back = max(0, min(100, back))
        forward = max(0, min(100, forward))

        assist_mode = self.plc.current_mode == 'assist'
        effective_back = 0 if assist_mode else back
        current_max = forward if assist_mode else max(forward, back)

        if not self.plc.connected:
            if self.training_active and current_max > self.max_resistance:
                self.max_resistance = current_max

            return {
                'status': 'warning',
                'message': (
                    f'PLC not connected. Resistance values saved: '
                    f'FWD={forward}%, BACK={effective_back}%'
                )
            }

        # Send both values in one socket lock so another HTTP request cannot
        # insert a command between forward and back resistance.
        success = self.plc.set_resistance_pair(
            back_percent=back,
            forward_percent=forward,
            assist_mode=assist_mode
        )

        if self.training_active and current_max > self.max_resistance:
            self.max_resistance = current_max

        return {
            'status': 'success' if success else 'error',
            'message': (
                f'Resistance updated: FWD={forward}%, BACK={effective_back}% '
                f'(mode: {self.plc.current_mode})'
            ),
            'scaling': '0%=10, 100%=910'
        }

    def set_reference_position(self, value: int = 1) -> Dict:
        success = self.plc.set_reference(value)

        return {
            'status': 'success' if success else 'error',
            'message': 'Reference position set' if success else 'Failed to set reference'
        }


golf_system = GolfTrainingSystem()
app = Flask(__name__)


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/start', methods=['POST'])
def start_motor():
    try:
        data = request.json
        result = golf_system.start_training(data)
        return jsonify(result)
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': str(e),
            'count': 0,
            'successRate': "0%"
        }), 500


@app.route('/stop', methods=['POST'])
def stop_motor():
    try:
        result = golf_system.stop_training()
        return jsonify(result)
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/reset', methods=['POST'])
def reset_plc():
    try:
        data = request.json or {}
        val = data.get('value', 1)

        success = golf_system.plc.send_command(39, val)

        return jsonify({
            'status': 'success' if success else 'error',
            'message': f'Reset command sent: {val}' if success else 'Failed to send reset command'
        })

    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/status', methods=['GET'])
def get_status():
    try:
        include_session = request.args.get('include_session', 'false').lower() == 'true'
        status = golf_system.get_current_status(include_session=include_session)
        return jsonify(status)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/power', methods=['POST'])
def control_power():
    try:
        data = request.json
        on = data.get('on', False)
        result = golf_system.control_power(on)
        return jsonify(result)
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/mode', methods=['POST'])
def set_mode():
    try:
        data = request.json
        mode = data.get('mode', 'neutral')
        result = golf_system.set_mode_realtime(mode)
        return jsonify(result)
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/reference_angle', methods=['POST'])
def set_reference_angle():
    try:
        data = request.json
        angle = data.get('angle', 0)
        result = golf_system.set_reference_angle_realtime(angle, channel='primary')
        return jsonify(result)
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/reference_angle_secondary', methods=['POST'])
def set_reference_angle_secondary():
    try:
        data = request.json
        angle = data.get('angle', 0)
        result = golf_system.set_reference_angle_realtime(angle, channel='secondary')
        return jsonify(result)
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/retro_settings', methods=['POST'])
def set_retro_settings():
    try:
        data = request.json
        back_resistance = data.get('back_resistance', 0)
        angle = data.get('angle', 0)
        channel = data.get('channel', 'primary')

        success = golf_system.plc.set_retro_settings(back_resistance, angle, channel=channel)

        return jsonify({
            'status': 'success' if success else 'error',
            'message': f'Retro settings ({channel}): Back={back_resistance}%, Angle={angle}°'
        })

    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/users', methods=['POST'])
def create_user():
    try:
        data = request.json
        name = data.get('name')
        hand_preference = data.get('hand_preference')

        if not name:
            return jsonify({'status': 'error', 'message': 'Name is required'}), 400

        user_data = golf_system.db.get_or_create_user(name, hand_preference)

        return jsonify({
            'status': 'success',
            'message': 'User created/retrieved',
            'user': user_data
        })

    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/users/<name>', methods=['DELETE'])
def delete_user(name):
    try:
        success = golf_system.db.delete_user(unquote(name))

        if success:
            return jsonify({'status': 'success', 'message': 'User deleted'})

        return jsonify({'status': 'error', 'message': 'Failed to delete or user not found'}), 404

    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/resistance', methods=['POST'])
def update_resistance():
    try:
        data = request.json
        back = data.get('back', 50)
        forward = data.get('forward', 50)

        result = golf_system.update_resistance(back, forward)
        return jsonify(result)

    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/reference', methods=['POST'])
def set_reference():
    try:
        data = request.json
        value = data.get('value', 1)
        result = golf_system.set_reference_position(value)
        return jsonify(result)
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/set_hand', methods=['POST'])
def set_hand_route():
    try:
        data = request.json
        hand_id = data.get('id')
        value = data.get('value')

        success = golf_system.plc.set_hand_preference(hand_id, value)

        return jsonify({
            'status': 'success' if success else 'error',
            'message': f"Hand command sent: ID {hand_id}, Value {value}"
        })

    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/users', methods=['GET'])
def get_all_users():
    try:
        users = golf_system.db.get_all_users()
        return jsonify({'status': 'success', 'users': users, 'count': len(users)})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/users/<username>', methods=['GET'])
def get_user_details(username):
    try:
        user_details = golf_system.db.get_user_details(username)

        if not user_details:
            return jsonify({'status': 'error', 'message': f'User {username} not found'}), 404

        return jsonify({'status': 'success', 'user': user_details})

    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/users/search', methods=['GET'])
def search_users():
    try:
        query = request.args.get('q', '').strip()
        all_users = golf_system.db.get_all_users()
        filtered = [u for u in all_users if query.lower() in u['name'].lower()]

        return jsonify({
            'status': 'success',
            'users': filtered[:10],
            'query': query
        })

    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


if __name__ == '__main__':
    golf_system.plc.connect()

    try:
        web_host = '0.0.0.0'

        time.sleep(1.5)

        app.run(debug=True, host=web_host, port=5000, use_reloader=False)

    finally:
        golf_system.plc.disconnect()