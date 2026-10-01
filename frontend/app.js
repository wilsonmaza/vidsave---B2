// Etapa 1: só precisamos de provar que o frontend fala com o backend.
// Isto muda quando entrarem os endpoints reais de resolve/download.
const API_BASE_URL = 'http://localhost:3000';

const dot = document.getElementById('statusDot');
const text = document.getElementById('statusText');

async function checkHealth() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/health`);
    if (!response.ok) throw new Error('Resposta não OK');

    const data = await response.json();
    dot.classList.add('ok');
    text.textContent = `Backend ligado (uptime: ${data.uptimeSeconds}s)`;
  } catch (err) {
    dot.classList.add('error');
    text.textContent = 'Backend não está acessível.';
  }
}

checkHealth();
