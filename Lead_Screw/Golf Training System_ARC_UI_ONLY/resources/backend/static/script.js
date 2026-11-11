// Global Variables
let isRightHand = true;
let selectedUser = null;
let selectedUserName = null;
let allUsers = [];
let statusUpdateInterval = null;
let powerStatus = false;
let isReferencePointSet = false;
let activeHandCommandId = 20;
let isTrainingActive = false; // Track local state

// Resistance updates are COMMIT-ONLY:
// - dragging/typing updates the UI locally
// - PLC updates only on slider release, Enter, or input blur
// - requests are serialized and only the newest pending pair is retained
let resistanceRequestInFlight = false;
let pendingResistancePair = null;
let lastResistanceCommitKey = null;
let lastResistanceCommitTime = 0;

const sliders = [
    { slider: 'resistanceSlider1', value: 'resistanceValue1', input: 'resistanceInput1' },
    { slider: 'resistanceSlider2', value: 'resistanceValue2', input: 'resistanceInput2' }
];

const dialAngles = {
    primary: 0,
    secondary: 0
};

function normalizeAngle(angle) {
    let normalized = angle;
    while (normalized > 180) normalized -= 360;
    while (normalized < -180) normalized += 360;
    return normalized;
}

function angleToClockTime(angleDeg) {
    let totalHours = (-angleDeg / 30) + 6;
    while (totalHours <= 0) totalHours += 12;
    while (totalHours > 12) totalHours -= 12;
    let hours = Math.floor(totalHours);
    let minutes = Math.round((totalHours - hours) * 60);
    if (minutes === 60) {
        minutes = 0;
        hours += 1;
        if (hours > 12) hours = 1;
    }
    if (hours === 0) hours = 12;
    return `${hours}:${minutes.toString().padStart(2, '0')}`;
}

function clockTimeToAngle(timeStr) {
    const match = timeStr.trim().match(/^(\d{1,2}):(\d{1,2})$/);
    if (!match) {
        return 0;
    }
    let hours = parseInt(match[1], 10);
    let minutes = parseInt(match[2], 10);
    if (isNaN(hours) || isNaN(minutes)) return 0;
    hours = hours % 12;
    minutes = Math.min(Math.max(minutes, 0), 59);
    const totalHours = hours + (minutes / 60);
    let angle = -((totalHours - 6) * 30);
    angle = ((angle + 180) % 360) - 180;
    return Math.round(angle);
}

function setAngleInputDisplay(inputId, angle) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = angleToClockTime(angle);
}

function getAngleValueFromInput(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return 0;
    return clockTimeToAngle(input.value || '6:00');
}

function handleDialAngleChange(channel, angle) {
    const key = channel === 'secondary' ? 'secondary' : 'primary';
    dialAngles[key] = normalizeAngle(angle);
    const modeReferenceRadio = document.getElementById('modeRefrence');
    const modeRetroRadio = document.getElementById('modeRetro');
    if (modeReferenceRadio && modeReferenceRadio.checked) {
        sendReferenceAngle(channel);
    }
    if (modeRetroRadio && modeRetroRadio.checked) {
        sendRetroSettings(channel);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const handRadio = document.querySelector('input[name="hand"]:checked');
    isRightHand = handRadio ? handRadio.value === 'righthand' : false;

    // Hook hand preference change to send exclusive PLC commands IMMEDIATELY
    const leftHandRadio = document.getElementById('lefthand');
    const rightHandRadio = document.getElementById('righthand');

    leftHandRadio.addEventListener('change', () => {
        if (leftHandRadio.checked) {
            sendHandCommand(20); // Left Hand Command ID 20
        }
    });

    rightHandRadio.addEventListener('change', () => {
        if (rightHandRadio.checked) {
            sendHandCommand(15); // Right Hand Command ID 15
        }
    });

    if (rightHandRadio.checked) {
        sendHandCommand(15, false);
    } else if (leftHandRadio.checked) {
        sendHandCommand(20, false);
    }

    // Set default date
    document.getElementById('currentDate').value = new Date().toLocaleDateString();

    setAngleInputDisplay('angleInput', dialAngles.primary);
    setAngleInputDisplay('angleInput2', dialAngles.secondary);
    initAngleDial({
        canvasId: 'angleDial',
        inputId: 'angleInput',
        channel: 'primary',
        onAngleChange: (angle) => handleDialAngleChange('primary', angle)
    });
    initAngleDial({
        canvasId: 'angleDial2',
        inputId: 'angleInput2',
        channel: 'secondary',
        onAngleChange: (angle) => handleDialAngleChange('secondary', angle)
    });

    sliders.forEach(({ slider, value, input }) => {
        const elSlider = document.getElementById(slider);
        const elValue = document.getElementById(value);
        const elInput = document.getElementById(input);

        // LIVE UI ONLY. Do not send intermediate slider values to the PLC.
        elSlider.addEventListener('input', () => {
            const val = elSlider.value;
            elValue.textContent = val;
            elInput.value = val;
        });

        // Send exactly one final resistance pair when the slider is released.
        elSlider.addEventListener('change', () => {
            commitResistanceUpdate();
        });

        // LIVE UI ONLY while typing. Example: typing "34" must not send "3" first.
        elInput.addEventListener('input', () => {
            const raw = elInput.value.trim();

            // Permit a temporary blank field while the operator edits the value.
            if (raw === '') {
                return;
            }

            let val = parseInt(raw, 10);
            if (Number.isNaN(val)) {
                return;
            }

            val = Math.max(0, Math.min(100, val));
            elSlider.value = val;
            elValue.textContent = val;
        });

        // Enter commits the completed number once.
        elInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                finalizeResistanceNumber(elInput, elSlider, elValue);
                commitResistanceUpdate();
                elInput.blur();
            }
        });

        // Clicking/tapping away also commits the completed number once.
        elInput.addEventListener('blur', () => {
            finalizeResistanceNumber(elInput, elSlider, elValue);
            commitResistanceUpdate();
        });
    });

    const modeResistanceRadio = document.getElementById('modeResistance');
    const modeRetroRadio = document.getElementById('modeRetro');  // CHANGED from modeNeutralRadio
    const modeAssistRadio = document.getElementById('modeAssist');
    const modeReferenceRadio = document.getElementById('modeRefrence');

    if (modeResistanceRadio) modeResistanceRadio.addEventListener('change', () => {
        sendModeCommand('resistance');
    });
    if (modeRetroRadio) modeRetroRadio.addEventListener('change', () => {  // CHANGED
        sendModeCommand('retro');  // CHANGED to 'retro'
    });
    if (modeAssistRadio) modeAssistRadio.addEventListener('change', () => {
        sendModeCommand('assist');
    });
    if (modeReferenceRadio) modeReferenceRadio.addEventListener('change', () => {
        sendModeCommand('reference');
    });

    ['howManyInput', 'highestLevelInput'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', updateCircularProgressBars);
        }
    });

    loadAllUsers();

    createUserDetailsModal();

    startStatusPolling();

    setupPowerButton();
});

// ==================== REAL-TIME MODE COMMAND ====================

async function sendModeCommand(mode) {

    try {
        const response = await fetch('/mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: mode })
        });

        const data = await response.json();

        if (data.status === 'success') {
            showNotification(`Mode set to ${mode.toUpperCase()}`, 'success');

            if (mode === 'assist') {
                console.log('Assist mode active. Back is fixed at 0%; Forward Assist is fixed at 15%.');

                const backSlider = document.getElementById('resistanceSlider1');
                const backInput = document.getElementById('resistanceInput1');
                const backValue = document.getElementById('resistanceValue1');
                const forwardSlider = document.getElementById('resistanceSlider2');
                const forwardInput = document.getElementById('resistanceInput2');
                const forwardValue = document.getElementById('resistanceValue2');

                if (backSlider) backSlider.value = 0;
                if (backInput) backInput.value = 0;
                if (backValue) backValue.textContent = 0;
                if (forwardSlider) forwardSlider.value = 15;
                if (forwardInput) forwardInput.value = 15;
                if (forwardValue) forwardValue.textContent = 15;

                // Keep the ARC range paint in sync when the UI helper is loaded.
                if (typeof arcPaintRange === 'function') {
                    arcPaintRange(backSlider);
                    arcPaintRange(forwardSlider);
                }
            }

            if (mode === 'reference') {
                setTimeout(() => {
                    sendReferenceAngle('primary');
                    sendReferenceAngle('secondary');
                }, 100);
            }

            if (mode === 'retro') {
                setTimeout(() => {
                    sendRetroSettings('primary');
                    sendRetroSettings('secondary');
                }, 100);
            }

            setTimeout(() => {
                sendResistanceUpdate();
            }, 50);

            // Reset dials to 6:00 (0 degrees) on mode change
            setAngleInputDisplay('angleInput', 0);
            handleDialAngleChange('primary', 0);

            setAngleInputDisplay('angleInput2', 0);
            handleDialAngleChange('secondary', 0);

            // Trigger change events to ensure UI updates are fully propagated
            const angleInput1 = document.getElementById('angleInput');
            const angleInput2 = document.getElementById('angleInput2');
            if (angleInput1) angleInput1.dispatchEvent(new Event('change'));
            if (angleInput2) angleInput2.dispatchEvent(new Event('change'));

        } else {
            showNotification('Failed to set mode', 'error');
        }
    } catch (error) {
        showNotification('Error setting mode', 'error');
    }
}


async function sendReferenceAngle(channel = 'primary') {
    const inputId = channel === 'secondary' ? 'angleInput2' : 'angleInput';
    const angle = getAngleValueFromInput(inputId);
    const plcValue = Math.round(angle * 2.25);
    const endpoint = channel === 'secondary' ? '/reference_angle_secondary' : '/reference_angle';


    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ angle: angle, plc_value: plcValue })
        });

        const data = await response.json();

        if (data.status === 'success') {
            showNotification(`${channel === 'secondary' ? 'Secondary' : 'Primary'} reference angle set: ${angle}°`, 'success');
        } else {
            showNotification('Failed to set reference angle', 'error');
        }
    } catch (error) {
        showNotification('Error setting reference angle', 'error');
    }
}


async function sendRetroSettings(channel = 'primary') {
    const backResistance = parseInt(document.getElementById('resistanceSlider1').value) || 0;
    const inputId = channel === 'secondary' ? 'angleInput2' : 'angleInput';
    const angle = getAngleValueFromInput(inputId);


    try {
        const response = await fetch('/retro_settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                back_resistance: backResistance,
                angle: angle,
                channel
            })
        });

        const data = await response.json();

        if (data.status === 'success') {
            console.log(`✓ ${channel.toUpperCase()} retro settings applied: Back=${backResistance}%, Angle=${angle}°`);
            showNotification(`Retro mode (${channel === 'secondary' ? 'Secondary' : 'Primary'}): Back=${backResistance}%, Angle=${angle}°`, 'success');
        } else {
            showNotification('Failed to set retro settings', 'error');
        }
    } catch (error) {
        showNotification('Error setting retro settings', 'error');
    }
}


function setupPowerButton() {
    const powerBtn = document.getElementById('onOffBtn');
    if (powerBtn) {
        powerBtn.addEventListener('click', togglePower);
        updatePowerButtonUI();
    }
}

async function togglePower() {
    powerStatus = !powerStatus;

    try {
        const response = await fetch('/power', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: powerStatus })
        });

        const data = await response.json();

        if (data.status === 'success') {
            console.log(`✓ Power: ${data.power}`);
            updatePowerButtonUI();
            showNotification(`Motor power turned ${data.power}`, 'success');
        } else {
            powerStatus = !powerStatus;
            showNotification('Failed to control power', 'error');
        }
    } catch (error) {
        powerStatus = !powerStatus;
        showNotification('Error controlling power', 'error');
    }
}

function updatePowerButtonUI() {
    const powerBtn = document.getElementById('onOffBtn');
    if (powerBtn) {
        if (powerStatus) {
            powerBtn.classList.remove('red');
            powerBtn.classList.add('green');
            powerBtn.innerHTML = '<i class="bi bi-power"></i> POWER ON';
        } else {
            powerBtn.classList.remove('green');
            powerBtn.classList.add('red');
            powerBtn.innerHTML = '<i class="bi bi-power"></i> POWER OFF';
        }
    }
}


async function sendResetCommand() {
    const btn = document.getElementById('resetBtn');
    if (!btn) return;

    // Visual Feedback: Active
    const originalClass = 'red';
    const activeClass = 'active-green';

    btn.classList.remove(originalClass);
    btn.classList.add(activeClass);
    btn.innerHTML = '<i class="fas fa-check"></i> SUCCESS';

    // Step 1: Send ON (39, 1)
    try {
        const response = await fetch('/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: 1 })
        });
        const data = await response.json();
    } catch (error) {
        showNotification('Error sending reset ON', 'error');
    }

    // Step 2 & 3: Wait 4s, then Send OFF (39, 0) & Reset UI
    setTimeout(async () => {
        try {
            await fetch('/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value: 0 })
            });
        } catch (error) {
            console.error('Error sending reset OFF');
        }

        btn.classList.remove(activeClass);
        btn.classList.add(originalClass);
        btn.innerHTML = '<i class="fas fa-undo"></i> RESET';
    }, 4000);
}


function startStatusPolling() {
    const poll = async () => {
        try {
            const response = await fetch('/status');
            const data = await response.json();

            const btn = document.getElementById('startBtn');
            if (data.training_active) {
                isTrainingActive = true;
                if (btn) {
                    btn.classList.remove('grey');
                    btn.classList.add('active-green');
                }
                document.getElementById('runCount').textContent = data.swing_count || 0;
                document.getElementById('successRate').textContent = data.best_score || "0%";
                updateCircularProgressBars();
            } else {
                isTrainingActive = false;
                if (btn) {
                    btn.classList.remove('active-green');
                    btn.classList.add('grey');
                }
            }
        } catch (error) {
            console.error('Status poll error:', error);
        }

        // Variable polling: 2s if active, 10s if idle (Heartbeat)
        const delay = isTrainingActive ? 2000 : 10000;
        statusUpdateInterval = setTimeout(poll, delay);
    };

    poll(); // Start loop
}


async function loadAllUsers() {
    try {
        const response = await fetch('/api/users');
        const data = await response.json();

        if (data.status === 'success') {
            allUsers = data.users;
        }
    } catch (error) {
        console.error('Error loading users:', error);
    }
}

function togglePlayerFields() {
    const playerType = document.getElementById('playerType').value;
    const newUserContainer = document.getElementById('newUserContainer');
    const existingUserContainer = document.getElementById('existingUserContainer');
    const existingUserSelect = document.getElementById('existingUserSelect');
    const deleteBtn = document.getElementById('deleteUserBtn');

    // Default: Hide all specific containers
    if (newUserContainer) newUserContainer.style.display = 'none';
    if (existingUserContainer) existingUserContainer.style.display = 'none';
    if (deleteBtn) deleteBtn.style.display = 'none';

    if (playerType === 'existing') {
        if (existingUserContainer) existingUserContainer.style.display = 'block';
        if (!existingUserSelect) {
            createExistingUserSelect();
        }
        // if(deleteBtn) deleteBtn.style.display = 'block'; // Removed as per request
        populateUserList();
    } else if (playerType === 'new') {
        openNewUserModal(); // Open modal immediately
        selectedUser = null;
        selectedUserName = null;
    } else {
        // 'Select User Type' case - nothing shown
        selectedUser = null;
        selectedUserName = null;
    }
}

function createExistingUserSelect() {
    // Inject into userListInjectionPoint instead of main container
    const container = document.getElementById('userListInjectionPoint');
    if (!container) return;

    const selectDiv = document.createElement('div');
    selectDiv.id = 'existingUserSelect';
    selectDiv.style.cssText = 'width: 100%; margin-top: 10px;';

    selectDiv.innerHTML = `
    <input 
      type="text" 
      id="userSearchInput" 
      placeholder="Search or select user..." 
      style="width: 100%; padding: 12px; border: 2px solid #4CAF50; border-radius: 8px; margin-bottom: 10px; font-size: 18px; background: #f0f0f0; color: #333; box-sizing: border-box;"
      oninput="filterUsers(this.value)"
      onfocus="showUserList()"
    />
    <div id="userListContainer" style="max-height: 250px; overflow-y: auto; border: 2px solid #4CAF50; border-radius: 8px; background: white; display: none; box-shadow: 0 4px 10px rgba(0,0,0,0.2);"></div>
    `;

    container.appendChild(selectDiv);

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#existingUserSelect')) {
            hideUserList();
        }
    });
}

function showUserList() {
    const container = document.getElementById('userListContainer');
    if (container) {
        container.style.display = 'block';
        populateUserList();
    }
}

function hideUserList() {
    const container = document.getElementById('userListContainer');
    if (container) {
        container.style.display = 'none';
    }
}

function addUser() {
    const nameInput = document.getElementById('userName');
    const name = nameInput.value.trim();
    if (!name) {
        showNotification('Please enter a user name', 'error');
        return;
    }

    fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
    })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'success') {
                showNotification('User added successfully', 'success');
                // Auto-select the new user and switch to Existing view logic
                selectedUser = data.user;
                selectedUserName = data.user.name;

                // Switch dropdown
                const playerType = document.getElementById('playerType');
                playerType.value = 'existing';
                togglePlayerFields(); // Updates UI

                // Fill search and select
                setTimeout(() => {
                    const searchInput = document.getElementById('userSearchInput');
                    if (searchInput) searchInput.value = selectedUserName;
                    selectUser(selectedUser); // Trigger selection logic (modal etc)
                }, 100);

            } else {
                showNotification(data.message || 'Failed to add user', 'error');
            }
        })
        .catch(err => showNotification('Error adding user', 'error'));
}

function deleteCurrentUser() {
    if (!selectedUser || !selectedUserName) {
        showNotification('No user selected', 'error');
        return;
    }

    if (!confirm(`Are you sure you want to delete user "${selectedUserName}"?`)) return;

    fetch(`/api/users/${encodeURIComponent(selectedUserName)}`, {
        method: 'DELETE'
    })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'success') {
                showNotification('User deleted', 'success');
                selectedUser = null;
                selectedUserName = null;

                // Reset UI
                const searchInput = document.getElementById('userSearchInput');
                if (searchInput) searchInput.value = '';

                // Refresh list if open
                populateUserList();

                // Should probably reset selection state UI
                loadAllUsers();
            } else {
                showNotification(data.message || 'Failed to delete user', 'error');
            }
        })
        .catch(err => showNotification('Error deleting user', 'error'));
}

function populateUserList(filter = '') {
    const container = document.getElementById('userListContainer');
    if (!container) return;

    const filteredUsers = allUsers.filter(user =>
        user.name.toLowerCase().includes(filter.toLowerCase())
    );

    if (filteredUsers.length === 0) {
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: #666; font-size: 16px;">No users found</div>';
        return;
    }

    container.innerHTML = '';

    filteredUsers.forEach(user => {
        const userDiv = document.createElement('div');
        userDiv.style.cssText = `padding: 15px; cursor: pointer; border-bottom: 1px solid #e0e0e0; transition: background 0.2s; background: white;`;

        userDiv.innerHTML = `
      <div style="font-weight: 600; color: #1a1a1a; font-size: 18px; margin-bottom: 4px;">${user.name}</div>
      <div style="font-size: 14px; color: #555;">
        <span style="color: #4CAF50; font-weight: 600;">Best: ${user.best_score.toFixed(1)}%</span> | 
        Sessions: ${user.total_sessions} | 
        Swings: ${user.total_swings}
      </div>
    `;

        userDiv.onmouseover = () => userDiv.style.background = '#f0f9ff';
        userDiv.onmouseout = () => userDiv.style.background = 'white';
        userDiv.onclick = () => selectExistingUser(user.name);

        container.appendChild(userDiv);
    });
}

function filterUsers(query) {
    populateUserList(query);
}

async function selectExistingUser(username) {
    document.getElementById('userSearchInput').value = username;
    hideUserList();

    try {
        const response = await fetch(`/api/users/${encodeURIComponent(username)}`);
        const data = await response.json();

        if (data.status === 'success') {
            showUserDetailsModal(data.user);
        }
    } catch (error) {
        console.error('Error loading user details:', error);
        showNotification('Failed to load user details', 'error');
    }
}

function createNewUserModal() {
    const modal = document.createElement('div');
    modal.id = 'newUserModal';
    modal.style.cssText = `display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.85); z-index: 10001; align-items: center; justify-content: center;`;

    modal.innerHTML = `
    <div style="background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); width: 90%; max-width: 500px; border-radius: 20px; padding: 30px; position: relative; box-shadow: 0 25px 50px rgba(0,0,0,0.5); border: 2px solid rgba(76, 175, 80, 0.3);">
      <h2 style="color: white; margin-bottom: 25px; text-align: center;"><i class="fas fa-user-plus" style="color: #4CAF50; margin-right: 10px;"></i>New User</h2>
      
      <div style="margin-bottom: 20px;">
        <label style="color: #cbd5e1; display: block; margin-bottom: 8px;">Full Name</label>
        <input type="text" id="newUserNameInput" placeholder="Enter Full Name" style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #475569; background: #334155; color: white; font-size: 16px;">
      </div>
      
      <div style="margin-bottom: 25px;">
        <label style="color: #cbd5e1; display: block; margin-bottom: 12px;">Hand Preference</label>
        <div style="display: flex; gap: 20px; justify-content: center;">
          <label style="cursor: pointer; display: flex; align-items: center; gap: 8px; color: white;">
            <input type="radio" name="newHandPref" value="right" checked style="transform: scale(1.2);"> Right Handed
          </label>
          <label style="cursor: pointer; display: flex; align-items: center; gap: 8px; color: white;">
            <input type="radio" name="newHandPref" value="left" style="transform: scale(1.2);"> Left Handed
          </label>
        </div>
      </div>

      <div style="display: flex; gap: 10px;">
        <button onclick="closeNewUserModal()" style="flex: 1; padding: 12px; background: #475569; border: none; border-radius: 8px; color: white; cursor: pointer; font-weight: 600;">Cancel</button>
        <button onclick="submitNewUser()" style="flex: 1; padding: 12px; background: #4CAF50; border: none; border-radius: 8px; color: white; cursor: pointer; font-weight: 600;">Add User</button>
      </div>
    </div>
    `;

    document.body.appendChild(modal);

    modal.onclick = (e) => {
        if (e.target === modal) closeNewUserModal();
    }
}

function openNewUserModal() {
    const modal = document.getElementById('newUserModal');
    if (!modal) createNewUserModal();

    document.getElementById('newUserNameInput').value = '';
    // Reset radio
    const radios = document.getElementsByName('newHandPref');
    if (radios[0]) radios[0].checked = true; // Default right

    document.getElementById('newUserModal').style.display = 'flex';
}

function closeNewUserModal() {
    document.getElementById('newUserModal').style.display = 'none';
    // Reset dropdown if cancelled? Maybe set to default 'Select'
    const playerType = document.getElementById('playerType');
    if (playerType.value === 'new' && !selectedUser) {
        playerType.value = "";
    }
}

function submitNewUser() {
    const name = document.getElementById('newUserNameInput').value.trim();
    const handPref = document.querySelector('input[name="newHandPref"]:checked').value;

    if (!name) {
        showNotification('Please enter a name', 'error');
        return;
    }

    fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, hand_preference: handPref })
    })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'success') {
                showNotification('User created successfully', 'success');
                closeNewUserModal();

                // Auto-select
                selectedUser = data.user;
                selectedUserName = data.user.name;

                // Switch UI to existing
                const playerType = document.getElementById('playerType');
                playerType.value = 'existing';
                togglePlayerFields();

                // Fill search and select
                loadAllUsers().then(() => {
                    const searchInput = document.getElementById('userSearchInput');
                    if (searchInput) searchInput.value = selectedUserName;
                    populateUserList(); // Refresh list UI
                    selectUser(selectedUser);
                });
            } else {
                showNotification(data.message || 'Failed to create user', 'error');
            }
        })
        .catch(err => showNotification('Error creating user', 'error'));
}

function deleteUserFromModal() {
    if (!selectedUser) return;

    if (!confirm(`Are you sure you want to delete user "${selectedUser.name}"? This cannot be undone.`)) return;

    fetch(`/api/users/${encodeURIComponent(selectedUser.name)}`, { method: 'DELETE' })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'success') {
                showNotification('User deleted', 'success');
                closeUserDetailsModal();
                selectedUser = null;
                selectedUserName = null;

                // Reset Dropdown
                document.getElementById('playerType').value = "";
                togglePlayerFields();

                // Refresh user list from server
                loadAllUsers().then(() => {
                    // If we are in existing mode, this will refresh the list
                    const searchInput = document.getElementById('userSearchInput');
                    if (searchInput) {
                        searchInput.value = '';
                        populateUserList();
                    }
                });

            } else {
                showNotification(data.message, 'error');
            }
        })
        .catch(error => showNotification('Error deleting user', 'error'));
}


function createUserDetailsModal() {
    const modal = document.createElement('div');
    modal.id = 'userDetailsModal';
    modal.style.cssText = `display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.85); z-index: 10000; overflow-y: auto; padding: 20px;`;

    modal.innerHTML = `
    <div style="background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); max-width: 900px; margin: 50px auto; border-radius: 20px; padding: 40px; position: relative; box-shadow: 0 25px 50px rgba(0,0,0,0.5); border: 2px solid rgba(76, 175, 80, 0.3);">
      <span onclick="closeUserDetailsModal()" style="position: absolute; top: 25px; right: 30px; font-size: 35px; cursor: pointer; color: #94a3b8; transition: color 0.3s; font-weight: 300; line-height: 1;" onmouseover="this.style.color='#f87171'" onmouseout="this.style.color='#94a3b8'">&times;</span>
      
      <div id="modalContent"></div>
      
      <div style="display: flex; gap: 15px; margin-top: 35px; justify-content: flex-end; align-items: center;">
        <button onclick="deleteUserFromModal()" style="padding: 14px 35px; background: #ef4444; border: 2px solid #b91c1c; border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 16px; color: #f1f5f9; transition: all 0.3s; margin-right: auto;" onmouseover="this.style.background='#dc2626'" onmouseout="this.style.background='#ef4444'"><i class="fas fa-trash"></i> Delete User</button>
        
        <button onclick="closeUserDetailsModal()" style="padding: 14px 35px; background: #334155; border: 2px solid #475569; border-radius: 10px; cursor: pointer; font-weight: 600; font-size: 16px; color: #f1f5f9; transition: all 0.3s;" onmouseover="this.style.background='#475569'" onmouseout="this.style.background='#334155'">OK</button>
      </div>
    </div>
  `;

    document.body.appendChild(modal);

    modal.onclick = (e) => {
        if (e.target === modal) {
            closeUserDetailsModal();
        }
    };
}

function showUserDetailsModal(user) {
    selectedUser = user;
    const modal = document.getElementById('userDetailsModal');
    const content = document.getElementById('modalContent');

    let html = `
    <h2 style="margin: 0 0 25px 0; color: #f1f5f9; font-size: 32px; display: flex; align-items: center; gap: 12px;">
      <i class="bi bi-person-circle" style="color: #4CAF50;"></i> ${user.name}
    </h2>
    
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 18px; margin-bottom: 25px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 12px; text-align: center; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);">
        <div style="font-size: 13px; opacity: 0.95; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Best Score</div>
        <div style="font-size: 34px; font-weight: bold; margin-top: 8px;">${user.best_score.toFixed(1)}%</div>
      </div>
      <div style="background: linear-gradient(135deg, #48bb78 0%, #38a169 100%); color: white; padding: 20px; border-radius: 12px; text-align: center; box-shadow: 0 4px 15px rgba(72, 187, 120, 0.3);">
        <div style="font-size: 13px; opacity: 0.95; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Sessions</div>
        <div style="font-size: 34px; font-weight: bold; margin-top: 8px;">${user.total_sessions}</div>
      </div>
      <div style="background: linear-gradient(135deg, #f6ad55 0%, #ed8936 100%); color: white; padding: 20px; border-radius: 12px; text-align: center; box-shadow: 0 4px 15px rgba(246, 173, 85, 0.3);">
        <div style="font-size: 13px; opacity: 0.95; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Total Swings</div>
        <div style="font-size: 34px; font-weight: bold; margin-top: 8px;">${user.total_swings}</div>
      </div>
      <div style="background: linear-gradient(135deg, #4299e1 0%, #3182ce 100%); color: white; padding: 20px; border-radius: 12px; text-align: center; box-shadow: 0 4px 15px rgba(66, 153, 225, 0.3);">
        <div style="font-size: 13px; opacity: 0.95; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;">Avg Score</div>
        <div style="font-size: 34px; font-weight: bold; margin-top: 8px;">${user.avg_score.toFixed(1)}%</div>
      </div>
    </div>
  `;

    if (user.preferred_hand || user.preferred_back_swing_mode) {
        html += `
      <div style="background: rgba(76, 175, 80, 0.1); padding: 25px; border-radius: 12px; margin-bottom: 25px; border: 1px solid rgba(76, 175, 80, 0.3);">
        <h3 style="margin: 0 0 18px 0; color: #f1f5f9; font-size: 20px; display: flex; align-items: center; gap: 10px;">
          <i class="fas fa-cog" style="color: #4CAF50;"></i> Saved Preferences
        </h3>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; font-size: 15px; color: #cbd5e1;">
          <div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px;">
            <strong style="color: #f1f5f9;">Hand:</strong> <span style="color: #4CAF50;">${user.preferred_hand || 'N/A'}</span>
          </div>
          <div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px;">
            <strong style="color: #f1f5f9;">Mode:</strong> <span style="color: #4CAF50;">${user.preferred_back_swing_mode || 'N/A'}</span>
          </div>
          <div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px;">
            <strong style="color: #f1f5f9;">Back Resistance:</strong> <span style="color: #4CAF50;">${user.preferred_resistance_back !== null ? user.preferred_resistance_back + '%' : 'N/A'}</span>
          </div>
          <div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px;">
            <strong style="color: #f1f5f9;">Forward Resistance:</strong> <span style="color: #4CAF50;">${user.preferred_resistance_forward !== null ? user.preferred_resistance_forward + '%' : 'N/A'}</span>
          </div>
          <div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px;">
            <strong style="color: #f1f5f9;">Starting Angle:</strong> <span style="color: #4CAF50;">${user.preferred_starting_angle !== null ? user.preferred_starting_angle + '°' : 'N/A'}</span>
          </div>
        </div>
      </div>
    `;
    }

    if (user.recent_sessions && user.recent_sessions.length > 0) {
        html += `
      <div style="margin-top: 25px;">
        <h3 style="margin: 0 0 18px 0; color: #f1f5f9; font-size: 20px; display: flex; align-items: center; gap: 10px;">
          <i class="fas fa-chart-line" style="color: #4CAF50;"></i> Recent Sessions
        </h3>
        <div style="max-height: 300px; overflow-y: auto; background: rgba(255,255,255,0.05); border-radius: 10px; border: 1px solid rgba(255,255,255,0.1);">
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <thead>
              <tr style="background: rgba(76, 175, 80, 0.2); position: sticky; top: 0;">
                <th style="padding: 14px; text-align: left; color: #f1f5f9; font-weight: 600;">Date</th>
                <th style="padding: 14px; text-align: center; color: #f1f5f9; font-weight: 600;">Swings</th>
                <th style="padding: 14px; text-align: center; color: #f1f5f9; font-weight: 600;">Best Score</th>
                <th style="padding: 14px; text-align: center; color: #f1f5f9; font-weight: 600;">Duration</th>
              </tr>
            </thead>
            <tbody>
    `;

        user.recent_sessions.slice(0, 5).forEach((session, index) => {
            const date = new Date(session.start_time);
            const dateStr = date.toLocaleDateString();
            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const duration = session.duration_minutes ? session.duration_minutes.toFixed(1) + ' min' : 'N/A';

            html += `
        <tr style="border-bottom: 1px solid rgba(255,255,255,0.1); background: ${index % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent'};">
          <td style="padding: 14px; color: #cbd5e1;">${dateStr}<br/><small style="color: #64748b;">${timeStr}</small></td>
          <td style="padding: 14px; text-align: center; font-weight: 600; color: #94a3b8; font-size: 16px;">${session.total_swings}</td>
          <td style="padding: 14px; text-align: center; font-weight: 700; color: #4CAF50; font-size: 18px;">${session.best_score.toFixed(1)}%</td>
          <td style="padding: 14px; text-align: center; color: #94a3b8;">${duration}</td>
        </tr>
      `;
        });

        html += `
            </tbody>
          </table>
        </div>
      </div>
    `;
    }

    content.innerHTML = html;
    modal.style.display = 'block';
}

function closeUserDetailsModal() {
    document.getElementById('userDetailsModal').style.display = 'none';
}

function applyUserSettings() {
    if (!selectedUser) return;

    selectedUserName = selectedUser.name;

    const searchInput = document.getElementById('userSearchInput');
    if (searchInput) {
        searchInput.value = selectedUser.name;
    }

    if (selectedUser.preferred_hand) {
        const handRadio = document.querySelector(`input[name="hand"][value="${selectedUser.preferred_hand === 'RH' ? 'righthand' : 'lefthand'}"]`);
        if (handRadio) {
            handRadio.checked = true;
            handRadio.dispatchEvent(new Event('change'));
        }
    }

    if (selectedUser.preferred_back_swing_mode) {
        const modeRadio = document.querySelector(`input[name="mode"][value="${selectedUser.preferred_back_swing_mode}"]`);
        if (modeRadio) {
            modeRadio.checked = true;
            modeRadio.dispatchEvent(new Event('change'));
        }
    }

    if (selectedUser.preferred_resistance_back !== null) {
        const slider1 = document.getElementById('resistanceSlider1');
        const input1 = document.getElementById('resistanceInput1');
        if (slider1) {
            slider1.value = selectedUser.preferred_resistance_back;
            input1.value = selectedUser.preferred_resistance_back;
            document.getElementById('resistanceValue1').textContent = selectedUser.preferred_resistance_back;
        }
    }

    if (selectedUser.preferred_resistance_forward !== null) {
        const slider2 = document.getElementById('resistanceSlider2');
        const input2 = document.getElementById('resistanceInput2');
        if (slider2) {
            slider2.value = selectedUser.preferred_resistance_forward;
            input2.value = selectedUser.preferred_resistance_forward;
            document.getElementById('resistanceValue2').textContent = selectedUser.preferred_resistance_forward;
        }
    }

    setTimeout(() => {
        sendResistanceUpdate();
    }, 100);

    if (selectedUser.preferred_starting_angle !== null) {
        setAngleInputDisplay('angleInput', selectedUser.preferred_starting_angle);
        handleDialAngleChange('primary', selectedUser.preferred_starting_angle);
    }

    closeUserDetailsModal();
    showNotification(`Settings applied for ${selectedUser.name}`, 'success');

}


async function sendCommand() {
    const playerType = document.getElementById('playerType').value;
    let name;

    if (playerType === 'existing') {
        if (selectedUserName) {
            name = selectedUserName;
            console.log('Using stored user name:', name);
        } else {
            const searchInput = document.getElementById('userSearchInput');
            if (searchInput && searchInput.value) {
                name = searchInput.value.trim();
                console.log('Using search input:', name);
            } else if (selectedUser) {
                name = selectedUser.name;
                console.log('Using selectedUser:', name);
            }
        }

        if (!name) {
            alert("Please select an existing user and click 'Apply' first.");
            return;
        }
    } else {
        name = document.getElementById('userName').value.trim();
        if (!name) {
            alert("Please enter the player's name.");
            return;
        }

        const userExists = allUsers.find(u => u.name.toLowerCase() === name.toLowerCase());
        if (userExists) {
            const confirm = window.confirm(`User "${name}" already exists!\n\nWould you like to:\n- Click OK to use existing user\n- Click Cancel to choose a different name`);

            if (confirm) {
                document.getElementById('playerType').value = 'existing';
                togglePlayerFields();
                selectedUserName = userExists.name;
                showNotification(`Switched to existing user: ${userExists.name}`, 'info');
            }
            return;
        }
    }


    const date = document.getElementById('currentDate').value;
    const backSwingMode = document.querySelector('input[name="mode"]:checked')?.value;
    const assistActive = document.getElementById('modeAssist')?.checked;
    const resistance1 = assistActive ? 0 : +document.getElementById('resistanceSlider1').value;
    const resistance2 = assistActive ? 15 : +document.getElementById('resistanceSlider2').value;
    const angle = dialAngles.primary ?? getAngleValueFromInput('angleInput');
    const handRadio = document.querySelector('input[name="hand"]:checked');
    const hand = handRadio.value === 'righthand' ? "RH" : "LH";

    const powerBtn = document.getElementById('onOffBtn');
    const power = powerBtn ? (powerBtn.classList.contains('active') ? 'ON' : 'OFF') : 'ON';

    const howManyTarget = parseInt(document.getElementById('howManyInput')?.value) || 100;
    const highestLevelTarget = parseInt(document.getElementById('highestLevelInput')?.value) || 100;

    const payload = {
        name,
        date,
        backSwingMode,
        resistance1,
        resistance2,
        angle,
        hand,
        power,
        howManyTarget,
        highestLevelTarget
    };


    fetch('/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'success') {

                document.getElementById('runCount').textContent = 0;
                document.getElementById('successRate').textContent = '0%';

                updateCircularProgressBars();

                showNotification(`Training started for ${name}!`, 'success');

                if (data.user_data && data.user_data.is_new) {
                    loadAllUsers();
                }
                isTrainingActive = true;
                document.getElementById('startBtn')?.classList.add('active-green');
            } else {
                showNotification(data.message || 'Failed to start training', 'error');
            }
        })
        .catch(error => {
            alert("Failed to send command. Please try again.");
        });
}

function finalizeResistanceNumber(elInput, elSlider, elValue) {
    let val = parseInt(elInput.value, 10);

    if (Number.isNaN(val)) {
        val = parseInt(elSlider.value, 10);
    }
    if (Number.isNaN(val)) {
        val = 0;
    }

    val = Math.max(0, Math.min(100, val));
    elInput.value = val;
    elSlider.value = val;
    elValue.textContent = val;
    return val;
}

function getResistancePairFromUI() {
    // Client Assist rule: the operator cannot alter resistance while Assist is active.
    // Existing PLC/backend logic forces Back to 0%; Forward Assist is fixed at 15%.
    if (document.getElementById('modeAssist')?.checked) {
        return { back: 0, forward: 15 };
    }

    let back = parseInt(document.getElementById('resistanceSlider1').value, 10);
    let forward = parseInt(document.getElementById('resistanceSlider2').value, 10);

    if (Number.isNaN(back)) back = 0;
    if (Number.isNaN(forward)) forward = 0;

    back = Math.max(0, Math.min(100, back));
    forward = Math.max(0, Math.min(100, forward));

    return { back, forward };
}

// Keep the old function name because other parts of this UI call it.
// It now performs a clean COMMIT rather than an uncontrolled real-time send.
function sendResistanceUpdate() {
    commitResistanceUpdate();
}

function commitResistanceUpdate() {
    const pair = getResistancePairFromUI();
    const key = `${pair.back}:${pair.forward}`;
    const now = Date.now();

    // Suppress the immediate duplicate caused by Enter -> blur.
    // The same values can still be intentionally re-sent later.
    if (key === lastResistanceCommitKey && (now - lastResistanceCommitTime) < 500) {
        return;
    }

    lastResistanceCommitKey = key;
    lastResistanceCommitTime = now;

    // If a request is already running, overwrite the pending value so only
    // the newest final pair survives. Old intermediate commands cannot queue up.
    pendingResistancePair = pair;
    processPendingResistanceUpdate();
}

async function processPendingResistanceUpdate() {
    if (resistanceRequestInFlight || !pendingResistancePair) {
        return;
    }

    resistanceRequestInFlight = true;

    try {
        while (pendingResistancePair) {
            const pair = pendingResistancePair;
            pendingResistancePair = null;

            try {
                const response = await fetch('/resistance', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(pair)
                });

                const data = await response.json();

                if (data.status === 'success') {
                    console.log(`Resistance committed -> Back=${pair.back}%, Forward=${pair.forward}%`);
                } else if (data.status === 'warning') {
                    console.warn('Resistance update warning:', data.message);
                } else {
                    console.error('Resistance update failed:', data.message);
                }
            } catch (error) {
                console.error('Network error during resistance update:', error);
            }
        }
    } finally {
        resistanceRequestInFlight = false;

        if (pendingResistancePair) {
            processPendingResistanceUpdate();
        }
    }
}

function stopCommand() {
    fetch('/stop', { method: 'POST' })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'success') {

                if (data.how_many_target !== undefined) {
                    document.getElementById('runCount').textContent = data.how_many_target;
                } else if (data.final_count !== undefined) {
                    document.getElementById('runCount').textContent = data.final_count;
                }

                if (data.highest_level_target !== undefined) {
                    document.getElementById('successRate').textContent = data.highest_level_target + '%';
                } else if (data.final_score) {
                    document.getElementById('successRate').textContent = data.final_score;
                }

                updateCircularProgressBars();

                showNotification(data.message, 'success');
                isTrainingActive = false;

                const startBtn = document.getElementById('startBtn');
                if (startBtn) {
                    startBtn.classList.remove('active-green');
                    startBtn.classList.add('grey');
                }

                // Reset Sliders to 0 - REMOVED as per request to keep slider values
                /*
                ['resistanceSlider1', 'resistanceSlider2'].forEach(id => {
                    const slider = document.getElementById(id);
                    if (slider) {
                        slider.value = 0;
                        slider.dispatchEvent(new Event('input')); // Updates text/value UI
                    }
                });
                */

                // Reset Dials to 0
                setAngleInputDisplay('angleInput', 0);
                handleDialAngleChange('primary', 0);

                setAngleInputDisplay('angleInput2', 0);
                handleDialAngleChange('secondary', 0);

                const angleInput1 = document.getElementById('angleInput');
                const angleInput2 = document.getElementById('angleInput2');
                if (angleInput1) angleInput1.dispatchEvent(new Event('change'));
                if (angleInput2) angleInput2.dispatchEvent(new Event('change'));

                if (selectedUser) {
                    loadAllUsers();
                    setTimeout(() => {
                        fetch(`/api/users/${encodeURIComponent(selectedUser.name)}`)
                            .then(res => res.json())
                            .then(data => {
                                if (data.status === 'success') {
                                    selectedUser = data.user;
                                }
                            });
                    }, 500);
                } else {
                    loadAllUsers();
                }
            } else {
                showNotification('Failed to stop training', 'error');
            }
        })
        .catch(error => {
            alert("Failed to stop motor. Please try again.");
        });
}

function sendHandCommand(selectedHandId, skipDeactivation = false) {
    const deactivateId = selectedHandId === 15 ? 20 : 15;

    if (!skipDeactivation && activeHandCommandId !== selectedHandId) {
        fetch('/set_hand', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: deactivateId, value: 0 })
        })
            .then(res => res.json())
            .then(data => {
                if (data.status === 'success') {
                    console.log(`Deactivated Hand Command: ID ${deactivateId}, Value 0`);
                } else {
                    console.error(`Failed to deactivate hand command ID ${deactivateId}`);
                }
            });
    }

    fetch('/set_hand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedHandId, value: 1 })
    })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'success') {
                activeHandCommandId = selectedHandId;
                const hand = selectedHandId === 15 ? 'Right Hand (15)' : 'Left Hand (20)';
                showNotification(`Hand set to ${hand}`, 'info');
                console.log(`✓ Activated Hand Command: ID ${selectedHandId}, Value 1`);
            } else {
                showNotification(`Failed to set hand preference: ${data.message}`, 'error');
            }
        })
        .catch(error => {
            console.error('Network error setting hand:', error);
            showNotification('Network error setting hand preference', 'error');
        });
}

function setReferencePoint() {
    const newValue = isReferencePointSet ? 0 : 1;
    const actionText = newValue === 1 ? 'SET' : 'RESET';


    fetch('/reference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: newValue })
    })
        .then(res => res.json())
        .then(data => {
            if (data.status === 'success') {
                isReferencePointSet = !isReferencePointSet;

                // Visual Feedback
                const btn = document.getElementById('setDropBtn');
                if (btn) {
                    if (isReferencePointSet) {
                        // Active State (using green like start button)
                        btn.classList.add('active-green');
                        btn.classList.remove('orange');
                        btn.innerHTML = '<i class="fas fa-crosshairs"></i> DROP SET';
                    } else {
                        // Inactive State (back to orange)
                        btn.classList.remove('active-green');
                        btn.classList.add('orange');
                        btn.innerHTML = '<i class="fas fa-crosshairs"></i> SET DROP';
                    }
                }

                const message = isReferencePointSet
                    ? 'Reference Point SET (Active)'
                    : 'Reference Point RESET (Inactive)';

                showNotification(message, isReferencePointSet ? 'success' : 'info');
            } else {
                showNotification(data.message || 'Failed to change reference status', 'error');
            }
        })
        .catch(error => {
            console.error('Network error setting reference point:', error);
            showNotification('Network error setting reference point', 'error');
        });
}

function showNotification(message, type = 'info') {
    return;
}

const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
  
  @keyframes slideOut {
    from {
      transform: translateX(0);
      opacity: 1;
    }
    to {
      transform: translateX(400px);
      opacity: 0;
    }
  }
`;
document.head.appendChild(style);


function updateCircularProgressBars() {
    const runCount = parseInt(document.getElementById('runCount')?.textContent) || 0;
    const successRateStr = document.getElementById('successRate')?.textContent || "0%";
    const successRate = parseFloat(successRateStr.replace('%', ''));

    const maxRuns = parseInt(document.getElementById('howManyInput')?.value) || 100;
    const maxLevel = parseInt(document.getElementById('highestLevelInput')?.value) || 100;

    const circumference = 2 * Math.PI * 40;

    const runProgress = Math.min((runCount / maxRuns) * circumference, circumference);
    const levelProgress = Math.min((successRate / maxLevel) * circumference, circumference);

    const runsProgressEl = document.getElementById('runsProgress');
    const levelProgressEl = document.getElementById('levelProgress');

    if (runsProgressEl) {
        runsProgressEl.setAttribute('stroke-dasharray', `${runProgress} ${circumference}`);
    }
    if (levelProgressEl) {
        levelProgressEl.setAttribute('stroke-dasharray', `${levelProgress} ${circumference}`);
    }
}

// Angle Dial Function
function initAngleDial({ canvasId, inputId, channel, onAngleChange }) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const radius = canvas.width / 2;
    const centerX = radius;
    const centerY = radius;
    const angleInput = document.getElementById(inputId);
    let currentAngle = getAngleValueFromInput(inputId);

    const clockImage = new Image();
    clockImage.src = '/static/clock.jpg';
    clockImage.onload = () => drawDial(currentAngle);

    function drawDial(angleDeg = currentAngle) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (clockImage.complete) {
            ctx.drawImage(clockImage, 0, 0, canvas.width, canvas.height);
        }
        drawAngleLine(angleDeg, '#4CAF50', 3);
        ctx.beginPath();
        ctx.arc(centerX, centerY, 3, 0, 2 * Math.PI);
        ctx.fillStyle = '#000';
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.fill();
        // Removed clock number display as per user request
    }

    function drawAngleLine(angleDeg, color, width) {
        const displayAngle = -angleDeg;
        const angleRad = ((displayAngle + 90) * Math.PI) / 180;

        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.rotate(angleRad);

        const clubLength = radius - 30;
        const shaftWidth = 3;
        const clubHeadSize = 15;

        const shaftLength = clubLength * 0.75;
        const shaftStartWidth = shaftWidth;
        const shaftEndWidth = shaftWidth * 0.7;

        const shaftGradient = ctx.createLinearGradient(0, 0, shaftLength, 0);
        shaftGradient.addColorStop(0, '#9E9E9E');
        shaftGradient.addColorStop(0.3, '#757575');
        shaftGradient.addColorStop(0.7, '#616161');
        shaftGradient.addColorStop(1, '#424242');

        ctx.beginPath();
        ctx.moveTo(0, -shaftStartWidth / 2);
        ctx.lineTo(shaftLength, -shaftEndWidth / 2);
        ctx.lineTo(shaftLength, shaftEndWidth / 2);
        ctx.lineTo(0, shaftStartWidth / 2);
        ctx.closePath();
        ctx.fillStyle = shaftGradient;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(0, -shaftStartWidth / 2 + 0.5);
        ctx.lineTo(shaftLength, -shaftEndWidth / 2 + 0.5);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 0.8;
        ctx.stroke();

        const hoselX = shaftLength;
        const hoselWidth = 4;
        const hoselHeight = 5;

        ctx.beginPath();
        ctx.rect(hoselX - 2, -hoselHeight / 2, hoselWidth, hoselHeight);
        const hoselGradient = ctx.createLinearGradient(hoselX - 2, 0, hoselX + 2, 0);
        hoselGradient.addColorStop(0, '#424242');
        hoselGradient.addColorStop(1, '#212121');
        ctx.fillStyle = hoselGradient;
        ctx.fill();
        ctx.strokeStyle = '#1B1B1B';
        ctx.lineWidth = 1;
        ctx.stroke();

        const headX = clubLength;
        const headLength = clubHeadSize;
        const headHeight = clubHeadSize * 0.55;

        ctx.beginPath();
        ctx.roundRect(headX - headLength / 2, -headHeight / 2, headLength, headHeight, 5);

        const headGradient = ctx.createRadialGradient(headX, 0, 0, headX, 0, headLength / 2);
        headGradient.addColorStop(0, '#FFD700');
        headGradient.addColorStop(0.4, '#FFA500');
        headGradient.addColorStop(0.8, '#CD853F');
        headGradient.addColorStop(1, '#8B4513');

        ctx.fillStyle = headGradient;
        ctx.fill();

        ctx.strokeStyle = '#B8860B';
        ctx.lineWidth = 2;
        ctx.stroke();

        const faceX = headX + headLength / 2 - 4;
        const faceWidth = 4;
        const faceHeight = headHeight * 0.85;

        ctx.beginPath();
        ctx.roundRect(faceX - faceWidth, -faceHeight / 2, faceWidth, faceHeight, 2);
        const faceGradient = ctx.createLinearGradient(faceX - faceWidth, 0, faceX, 0);
        faceGradient.addColorStop(0, '#F5F5F5');
        faceGradient.addColorStop(0.5, '#E0E0E0');
        faceGradient.addColorStop(1, '#BDBDBD');
        ctx.fillStyle = faceGradient;
        ctx.fill();

        const grooveCount = 6;
        const grooveSpacing = faceHeight / (grooveCount + 1);
        for (let i = 1; i <= grooveCount; i++) {
            const grooveY = -faceHeight / 2 + (grooveSpacing * i);
            ctx.beginPath();
            ctx.moveTo(faceX - faceWidth + 0.5, grooveY);
            ctx.lineTo(faceX - 0.5, grooveY);
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.lineWidth = 0.6;
            ctx.stroke();
        }

        ctx.beginPath();
        ctx.roundRect(headX - headLength / 2 + 2, -headHeight / 2 + 2, headLength * 0.5, headHeight * 0.4, 3);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(headX - headLength / 2 + 3, headHeight / 2 - 1);
        ctx.lineTo(headX + headLength / 2 - 3, headHeight / 2 - 1);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.restore();
    }

    function getAngleFromCoords(x, y) {
        const rect = canvas.getBoundingClientRect();
        const mouseX = x - rect.left;
        const mouseY = y - rect.top;
        const dx = mouseX - centerX;
        const dy = mouseY - centerY;
        let deg = Math.atan2(dy, dx) * (180 / Math.PI) - 90;
        if (deg < -180) deg += 360;

        deg = -deg;

        return Math.round(deg);
    }

    function updateAngle(angle) {
        const normalized = normalizeAngle(angle);
        currentAngle = normalized;
        setAngleInputDisplay(inputId, normalized);
        drawDial(normalized);
        if (typeof onAngleChange === 'function') {
            onAngleChange(normalized);
        }
    }

    let isDragging = false;

    canvas.addEventListener('mousedown', (e) => {
        isDragging = true;
        const angle = getAngleFromCoords(e.clientX, e.clientY);
        updateAngle(angle);
    });

    canvas.addEventListener('mousemove', (e) => {
        if (isDragging) {
            const angle = getAngleFromCoords(e.clientX, e.clientY);
            updateAngle(angle);
        }
    });

    canvas.addEventListener('mouseup', () => {
        isDragging = false;
    });

    canvas.addEventListener('mouseleave', () => {
        isDragging = false;
    });

    if (angleInput) {
        angleInput.addEventListener('change', () => {
            const angle = clockTimeToAngle(angleInput.value);
            updateAngle(angle);
        });
        angleInput.value = angleToClockTime(currentAngle);
    }

    drawDial(currentAngle);

    if (typeof onAngleChange === 'function') {
        onAngleChange(currentAngle);
    }
}