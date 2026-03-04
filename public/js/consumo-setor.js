function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

const setor = qs('setor');
const periodo = qs('periodo');
const de = qs('de');
const ate = qs('ate');

if (!setor) location.href = '/';

document.getElementById('titulo-setor').textContent = `Setor: ${setor}`;
document.getElementById('periodo-info').textContent = periodo ? `Período: ${periodo}` : (de && ate ? `Período: ${de} → ${ate}` : 'Período: últimos 7 dias');

async function carregar() {
  let url = `/api/impressoras/consumo?setor=${encodeURIComponent(setor)}`;
  if (de && ate) url += `&de=${de}&ate=${ate}`;
  else if (periodo) url += `&periodo=${periodo}`;

  const res = await fetch(url).then(r => r.json());
  const data = res.data ?? [];

  // Chart por impressora (folhas)
  const impressoraIds = data.map(d => d.impressora_id);
  const labels = data.map(d => d.impressora_id + ' — ' + (d.modelo ?? '') );
  const folhas = data.map(d => d.folhas ?? 0);

  const canvas = document.getElementById('chart-setor');
  const ctx = canvas.getContext('2d');
  new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Folhas', data: folhas, backgroundColor: '#06b6d4' }] },
    options: {
      onClick: (_evt, elements) => {
        if (!elements.length) return;
        const id = impressoraIds[elements[0].index];
        if (id) location.href = `impressora.html?id=${encodeURIComponent(id)}`;
      },
      scales: { y: { beginAtZero: true } },
      plugins: { legend: { display: false } },
    },
  });
  canvas.style.cursor = 'pointer';

  const tbody = document.getElementById('tbody-setor');
  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-muted text-center py-3">Nenhum dado encontrado para este setor.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(d => `
    <tr>
      <td><a href="impressora.html?id=${d.impressora_id}">${d.impressora_id}</a></td>
      <td>${d.modelo ?? '—'}</td>
      <td>${(d.faces ?? 0).toLocaleString('pt-BR')}</td>
      <td>${(d.folhas ?? 0).toLocaleString('pt-BR')}</td>
      <td>${(d.resmas ?? 0).toLocaleString('pt-BR')}</td>
    </tr>
  `).join('');
}

carregar();
