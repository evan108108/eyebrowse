const statusDot = document.getElementById('status-dot');
const daemonStatus = document.getElementById('daemon-status');
const pairedLabel = document.getElementById('paired-label');
const sessionList = document.getElementById('session-list');

let currentWindowId = null;

// --- Init ---

document.addEventListener('DOMContentLoaded', async () => {
  const win = await chrome.windows.getCurrent();
  currentWindowId = win.id;

  await loadStatus();
  await loadPairedSession();
  await loadSessions();
});

// --- Connection status ---

async function loadStatus() {
  const { connectionStatus } = await chrome.storage.session.get('connectionStatus');
  const status = connectionStatus || 'disconnected';

  const connected = status === 'connected';
  statusDot.classList.toggle('connected', connected);
  statusDot.classList.toggle('disconnected', !connected);

  // Show daemon-not-running message only when setup is needed
  if (status === 'setup-needed') {
    daemonStatus.classList.remove('hidden');
  } else {
    daemonStatus.classList.add('hidden');
  }
}

// --- Paired session ---

async function loadPairedSession() {
  const { windowPairings } = await chrome.storage.session.get('windowPairings');
  const pairings = windowPairings || {};
  const sessionName = pairings[currentWindowId];
  if (sessionName) {
    pairedLabel.textContent = `Paired with: ${sessionName}`;
    pairedLabel.classList.add('active');
  } else {
    pairedLabel.textContent = 'Not paired';
    pairedLabel.classList.remove('active');
  }
}

// --- Sessions ---

async function loadSessions() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getSessions' });
    const sessions = response?.sessions || [];
    renderSessions(sessions);
  } catch (err) {
    sessionList.innerHTML = '<li class="empty-state">Could not load sessions</li>';
  }
}

function renderSessions(sessions) {
  sessionList.innerHTML = '';

  if (!sessions.length) {
    sessionList.innerHTML = '<li class="empty-state">No active sessions</li>';
    return;
  }

  // Get current pairing to highlight
  chrome.storage.session.get('windowPairings', ({ windowPairings }) => {
    const pairings = windowPairings || {};
    const currentPairing = pairings[currentWindowId];

    sessions.forEach(session => {
      const li = document.createElement('li');
      li.className = 'session-item';

      const name = document.createElement('span');
      name.className = 'session-name';
      name.textContent = session.name || session.id;

      const btn = document.createElement('button');
      const isPaired = currentPairing === (session.name || session.id);

      if (isPaired) {
        btn.textContent = 'Disconnect';
        btn.className = 'btn btn-disconnect';
        li.classList.add('paired');
      } else {
        btn.textContent = 'Connect';
        btn.className = 'btn btn-connect';
      }

      btn.addEventListener('click', async () => {
        if (isPaired) {
          await chrome.runtime.sendMessage({
            type: 'unpairWindow',
            windowId: currentWindowId
          });
        } else {
          await chrome.runtime.sendMessage({
            type: 'pairWindow',
            windowId: currentWindowId,
            sessionName: session.name || session.id
          });
        }
        await loadPairedSession();
        await loadSessions();
      });

      li.appendChild(name);
      li.appendChild(btn);
      sessionList.appendChild(li);
    });
  });
}

// Listen for status changes to auto-refresh
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.connectionStatus) {
    loadStatus();
    loadSessions();
  }
});
