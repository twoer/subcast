const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const dot = document.getElementById('dot') as HTMLSpanElement;
const statusText = document.getElementById('status-text') as HTMLDivElement;

function updateUI(status: { active: boolean; wsStatus: string }): void {
  const { active, wsStatus } = status;

  startBtn.disabled = active;
  stopBtn.disabled = !active;

  dot.className = `dot ${wsStatus}`;
  const labels: Record<string, string> = {
    connected: active ? 'Listening...' : 'Connected',
    connecting: 'Connecting...',
    disconnected: 'Disconnected',
  };
  statusText.textContent = labels[wsStatus] ?? wsStatus;
}

startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.runtime.sendMessage({ type: 'start', tabId: tab.id }, (resp) => {
    if (resp?.ok) {
      updateUI({ active: true, wsStatus: 'connected' });
    }
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stop' }, (resp) => {
    if (resp?.ok) {
      updateUI({ active: false, wsStatus: 'disconnected' });
    }
  });
});

chrome.runtime.sendMessage({ type: 'status' }, (resp) => {
  if (resp) {
    updateUI(resp);
  }
});
