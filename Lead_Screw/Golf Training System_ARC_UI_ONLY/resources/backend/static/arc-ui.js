// ARC UI presentation helpers only.
// The proven machine/PLC functions remain in the original /static/script.js.

// Assist UI contract for this client build:
// - existing PLC logic already forces Back Swing to 0% in Assist
// - Forward Swing is fixed at 15%
// - both controls are locked so the operator cannot change them
let arcAssistLocked = false;
let arcResistanceBeforeAssist = null;

function arcOpenAdvanced() {
  const panel = document.getElementById('advancedPanel');
  if (panel) panel.style.display = 'flex';
}

function arcCloseAdvanced() {
  const panel = document.getElementById('advancedPanel');
  if (panel) panel.style.display = 'none';
}

function arcCloseUserPicker() {
  const panel = document.getElementById('existingUserContainer');
  if (panel) panel.style.display = 'none';
  const playerType = document.getElementById('playerType');
  if (playerType && playerType.value === 'existing' && !document.getElementById('userSearchInput')?.value) {
    playerType.value = '';
  }
}

function arcRegisterTrainee() {
  const playerType = document.getElementById('playerType');
  if (!playerType) return;
  playerType.value = 'new';
  togglePlayerFields();
}

function arcSelectTrainee() {
  const playerType = document.getElementById('playerType');
  if (!playerType) return;
  playerType.value = 'existing';
  togglePlayerFields();
  const container = document.getElementById('existingUserContainer');
  if (container) container.style.display = 'flex';
  setTimeout(() => document.getElementById('userSearchInput')?.focus(), 50);
}

function arcViewPastResults() {
  if (typeof selectedUser !== 'undefined' && selectedUser) {
    showUserDetailsModal(selectedUser);
    return;
  }
  arcSelectTrainee();
}

function arcSetAssistant(enabled) {
  const target = document.getElementById(enabled ? 'modeAssist' : 'modeResistance');
  if (!target) return;
  target.checked = true;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  arcSyncAssistantButtons();
}

function arcSetResistanceUi(sliderId, inputId, valueId, value) {
  const slider = document.getElementById(sliderId);
  const input = document.getElementById(inputId);
  const hiddenValue = document.getElementById(valueId);
  if (slider) slider.value = value;
  if (input) input.value = value;
  if (hiddenValue) hiddenValue.textContent = value;
  if (slider) arcPaintRange(slider);
}

function arcSetResistanceControlsLocked(locked) {
  const panel = document.querySelector('.arc-energy-panel');
  panel?.classList.toggle('arc-assist-locked', locked);

  ['resistanceSlider1', 'resistanceSlider2', 'resistanceInput1', 'resistanceInput2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = locked;
  });

  document.querySelectorAll('.arc-res-row .arc-step').forEach(btn => {
    btn.disabled = locked;
  });
}

function arcApplyAssistModeState() {
  const assistActive = !!document.getElementById('modeAssist')?.checked;

  if (assistActive) {
    if (!arcAssistLocked) {
      arcResistanceBeforeAssist = {
        back: parseInt(document.getElementById('resistanceSlider1')?.value, 10) || 0,
        forward: parseInt(document.getElementById('resistanceSlider2')?.value, 10) || 0
      };
    }

    arcAssistLocked = true;
    // IMPORTANT: existing backend Assist logic forces Back to 0%.
    // Forward is the active Assist level and is fixed to the client's 15%.
    arcSetResistanceUi('resistanceSlider1', 'resistanceInput1', 'resistanceValue1', 0);
    arcSetResistanceUi('resistanceSlider2', 'resistanceInput2', 'resistanceValue2', 15);
    arcSetResistanceControlsLocked(true);
    return;
  }

  const wasLocked = arcAssistLocked;
  arcAssistLocked = false;
  arcSetResistanceControlsLocked(false);

  if (wasLocked && arcResistanceBeforeAssist) {
    arcSetResistanceUi('resistanceSlider1', 'resistanceInput1', 'resistanceValue1', arcResistanceBeforeAssist.back);
    arcSetResistanceUi('resistanceSlider2', 'resistanceInput2', 'resistanceValue2', arcResistanceBeforeAssist.forward);
  }
  arcResistanceBeforeAssist = null;
}

function arcSyncAssistantButtons() {
  const yes = document.getElementById('arcAssistYes');
  const no = document.getElementById('arcAssistNo');
  const assist = document.getElementById('modeAssist');
  const resistance = document.getElementById('modeResistance');
  if (yes) yes.classList.toggle('selected', !!assist?.checked);
  if (no) no.classList.toggle('selected', !!resistance?.checked);
  arcApplyAssistModeState();
}

function arcNudgeResistance(sliderId, delta) {
  const slider = document.getElementById(sliderId);
  if (!slider || slider.disabled) return;
  const next = Math.max(0, Math.min(100, (parseInt(slider.value, 10) || 0) + delta));
  slider.value = next;
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  slider.dispatchEvent(new Event('change', { bubbles: true }));
}

function arcPaintRange(slider) {
  if (!slider) return;
  const value = Math.max(0, Math.min(100, parseInt(slider.value, 10) || 0));
  slider.style.background = `linear-gradient(90deg, #f3851e 0 ${value}%, #d7dbe0 ${value}% 100%)`;
}

function arcUpdateSelectedTrainee() {
  const label = document.getElementById('arcSelectedTrainee');
  if (!label) return;
  const search = document.getElementById('userSearchInput');
  const name = (typeof selectedUserName !== 'undefined' && selectedUserName) ||
               (typeof selectedUser !== 'undefined' && selectedUser?.name) ||
               search?.value || '';
  // The trainee name is shown large beside the STOP button.
  const nameEl = label.querySelector('.arc-trainee-name');
  if (!nameEl) return;
  nameEl.textContent = name || 'No trainee selected';
  nameEl.classList.toggle('is-empty', !name);
}

// Sport selection (visual only): Golf turns orange when clicked and stays selected.
// The other sports are "Coming soon" and are not clickable.
function arcSelectSport(card) {
  if (!card || card.classList.contains('disabled')) return;
  document.querySelectorAll('.arc-sport-card').forEach(c => {
    const on = c === card;
    c.classList.toggle('active', on);
    if (!c.classList.contains('disabled')) c.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

// Today's date beside the START button, e.g. "22 October 2026".
function arcUpdateDate() {
  const el = document.getElementById('arcDate');
  if (!el) return;
  el.textContent = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

document.addEventListener('DOMContentLoaded', () => {
  ['resistanceSlider1', 'resistanceSlider2'].forEach(id => {
    const slider = document.getElementById(id);
    if (!slider) return;
    arcPaintRange(slider);
    slider.addEventListener('input', () => arcPaintRange(slider));
  });

  ['modeResistance', 'modeAssist', 'modeRefrence', 'modeRetro'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', arcSyncAssistantButtons);
  });

  const advanced = document.getElementById('advancedPanel');
  advanced?.addEventListener('click', e => { if (e.target === advanced) arcCloseAdvanced(); });
  const picker = document.getElementById('existingUserContainer');
  picker?.addEventListener('click', e => { if (e.target === picker) arcCloseUserPicker(); });

  document.addEventListener('click', () => setTimeout(arcUpdateSelectedTrainee, 0));
  document.addEventListener('change', () => setTimeout(arcUpdateSelectedTrainee, 0));
  arcSyncAssistantButtons();
  arcUpdateSelectedTrainee();
  arcUpdateDate();
  setInterval(arcUpdateDate, 60000); // keeps the date correct if the app stays open past midnight
});
