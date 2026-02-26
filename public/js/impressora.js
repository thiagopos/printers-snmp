// ─── Mapeamento modelo → imagem ───────────────────────────────────────────────
const MODELO_IMG = {
  'Samsung M4020': 'img/impressoras/m4020.png',
  'HP E52645':     'img/impressoras/e52645.png',
  'HP 408dn':      'img/impressoras/408dn.png',
  'HP E57540 Cor': 'img/impressoras/e57540.png',
  'HP E87660 A3':  'img/impressoras/e87660.png',
};

// Cores de linha do gráfico por consumível
function configLinha(nome) {
  const n = nome.toLowerCase();
  if (n.includes('preto') || n.includes('black') || n.includes('cartucho'))
    return { border: '#1a1a2e', bg: 'rgba(26,26,46,.08)',    dash: [],     width: 3.5 };
  if (n.includes('ciano') || n.includes('cyan'))
    return { border: '#0284c7', bg: 'rgba(2,132,199,.08)',    dash: [],     width: 3.5 };
  if (n.includes('magenta'))
    return { border: '#db2777', bg: 'rgba(219,39,119,.08)',   dash: [],     width: 3.5 };
  if (n.includes('amarelo') || n.includes('yellow'))
    return { border: '#d97706', bg: 'rgba(217,119,6,.08)',    dash: [],     width: 3.5 };
  // Fusor / kit → cinza, tracejado
  if (n.includes('fusor') || n.includes('kit'))
    return { border: '#6b7280', bg: 'rgba(107,114,128,.06)', dash: [8, 4], width: 3   };
  // Fallback
  return   { border: '#7c3aed', bg: 'rgba(124,58,237,.08)', dash: [4, 4], width: 2.5 };
}

function classePercentual(pct) {
  if (pct == null) return 'secondary';
  if (pct < 10)   return 'danger';
  if (pct < 20)   return 'warning';
  return 'success';
}

function corBarra(nome) {
  const n = nome.toLowerCase();
  if (n.includes('preto') || n.includes('black') || n.includes('cartucho')) return '#1a1a2e';
  if (n.includes('ciano')   || n.includes('cyan'))    return '#0284c7';
  if (n.includes('magenta'))                           return '#db2777';
  if (n.includes('amarelo') || n.includes('yellow'))  return '#d97706';
  // fusor, kit, unidade → cinza neutro
  return '#6b7280';
}

function formatarData(s) {
  if (!s || s.length !== 8) return s ?? '—';
  return `${s.slice(6)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
}

function formatarDataHora(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ─── ID da impressora (query string) ─────────────────────────────────────────
const id = new URLSearchParams(location.search).get('id');
if (!id) location.href = '/';

let chartHistorico = null;

// ─── Carrega e renderiza tudo ─────────────────────────────────────────────────
async function carregar() {
  const data = await fetch(`/api/impressora/${id}`).then(r => r.json());
  if (data.erro) { alert(data.erro); location.href = '/'; return; }

  const { impressora, historico, dias_restantes, cartuchos, status_serie, serie_info, trocas } = data;

  // Título e imagem
  document.title = `${impressora.modelo} — ${impressora.setor}`;
  document.getElementById('nav-titulo').textContent = impressora.modelo;

  const ultimo = historico.at(-1);

  function ehTonerPuro(nome) {
    const n = nome.toLowerCase();
    return (n.includes('toner') || n.includes('cartucho')) && !n.includes('unidade') && !n.includes('coleta');
  }

  const temErro = status_serie === 'trocada'
    || !!([ultimo?.alerta, ultimo?.mensagem_tela]
        .filter(v => v && v.trim().replace(/\/$/, '').toLowerCase() !== 'pronto')
        .join(''))
    || (ultimo?.consumiveis ?? []).some(c => ehTonerPuro(c.nome) && c.percentual === 0);

  const imgSrc = temErro ? 'img/impressoras/error.png' : (MODELO_IMG[impressora.modelo] ?? '');
  document.getElementById('img-impressora').src = imgSrc;

  // Lupa: abre modal com imagem ampliada
  document.getElementById('btn-zoom-img').addEventListener('click', () => {
    document.getElementById('modal-zoom-img').src = imgSrc;
    bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-img-zoom')).show();
  });

  // ── Info: campos dinâmicos ──────────────────────────────────────────────────
  const campos = [
    ['Setor',         impressora.setor],
    ['Modelo',        impressora.modelo],
    ['Série',         impressora.serie ?? '—'],
    ['IP Liberty',    impressora.ip_liberty],
    ['IP Prodam',     impressora.ip_prodam ?? '—'],
    ['Total de Págs', ultimo?.total_paginas_dispositivo?.toLocaleString('pt-BR') ?? '—'],
    ['Duplex',        ultimo?.total_duplex != null ? ultimo.total_duplex.toLocaleString('pt-BR') : '—'],
    ['Snapshots',     historico.length],
  ];

  document.getElementById('info-impressora').innerHTML = campos.map(([k, v]) => `
    <div class="col-6 col-md-3">
      <div class="text-muted small mb-1">${k}</div>
      <div class="fw-semibold">${v}</div>
    </div>`).join('');

  // ── Consumíveis atuais + dias restantes ────────────────────────────────────
  const divConsums = document.getElementById('consumiveis-atuais');
  if (ultimo?.consumiveis?.length) {
    divConsums.innerHTML = ultimo.consumiveis
      .filter(c => !c.nome.toLowerCase().includes('unidade') && !c.nome.toLowerCase().includes('coleta'))
      .map(c => {
      const pct     = c.percentual ?? 0;
      const cls     = classePercentual(c.percentual);
      const dias    = dias_restantes[c.nome];
      const diasStr = dias != null
        ? `<span class="badge bg-${cls} bg-opacity-10 text-${cls} border border-${cls} ms-1">~${dias}d</span>`
        : '';

      // Cor da barra: toner real ou cinza para fusor/outros
      const barCor = corBarra(c.nome);

      return `
        <div class="mb-3">
          <div class="d-flex justify-content-between align-items-center mb-1">
            <span class="small fw-medium">${c.nome}</span>
            <span class="small">
              <span class="text-${cls} fw-bold">${c.percentual != null ? pct + '%' : '—'}</span>
              ${diasStr}
            </span>
          </div>
          <div class="progress">
            <div class="progress-bar" style="width:${pct}%;background:${barCor}"></div>
          </div>
          ${c.toner_pn ? `<div class="text-muted mt-1" style="font-size:.72rem">PN: ${c.toner_pn}</div>` : ''}
        </div>`;
    }).join('');
  } else {
    divConsums.innerHTML = '<p class="text-muted small">Sem dados disponíveis.</p>';
  }

  // ── Gráfico de histórico ────────────────────────────────────────────────────
  if (historico.length > 0) {
    document.getElementById('chart-subtitulo').textContent =
      `${historico.length} coleta(s)`;

    const labels = historico.map(s =>
      new Date(s.coletado_em).toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    );

    const nomes = [...new Set(historico.flatMap(s => s.consumiveis.map(c => c.nome)))]
      .filter(n => !n.toLowerCase().includes('unidade') && !n.toLowerCase().includes('coleta'))
      .sort();

    const datasets = nomes.map(nome => {
      const { border, bg, dash, width } = configLinha(nome);
      return {
        label:                nome,
        data:                 historico.map(s => s.consumiveis.find(c => c.nome === nome)?.percentual ?? null),
        borderColor:          border,
        backgroundColor:      bg,
        borderDash:           dash,
        borderWidth:          width,
        tension:              0.3,
        spanGaps:             true,
        pointRadius:          historico.length > 30 ? 2 : 4,
        pointBackgroundColor: border,
      };
    });

    const ctx = document.getElementById('chart-historico').getContext('2d');
    if (chartHistorico) chartHistorico.destroy();
    chartHistorico = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        scales: {
          y: { min: 0, max: 100, ticks: { callback: v => v + '%', font: { size: 13 } } },
          x: { ticks: { maxTicksLimit: 10, font: { size: 13 } } },
        },
        plugins: { legend: { position: 'bottom', labels: { font: { size: 14 } } } },
        interaction: { mode: 'index', intersect: false },
      },
    });
  } else {
    document.getElementById('chart-historico').closest('.card').querySelector('.card-body').innerHTML =
      '<p class="text-muted text-center py-4">Nenhum dado histórico ainda.</p>';
  }

  // ── Histórico de cartuchos ─────────────────────────────────────────────────
  const tbody = document.getElementById('tbody-cartuchos');
  if (cartuchos.length) {
    tbody.innerHTML = cartuchos.map(c => `
      <tr>
        <td class="fw-medium">${c.nome}</td>
        <td><code>${c.toner_pn ?? '—'}</code></td>
        <td><code class="text-muted small">${c.toner_serial ?? '—'}</code></td>
        <td>${formatarData(c.data_instalacao)}</td>
        <td>${formatarData(c.data_ultimo_uso)}</td>
        <td>${c.paginas_cartucho?.toLocaleString('pt-BR') ?? '—'}</td>
        <td class="text-muted small">${formatarDataHora(c.primeiro_visto)}</td>
      </tr>`).join('');
  } else {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-muted">Nenhum histórico de cartucho disponível.</td></tr>';
  }

  // ── Histórico de trocas ────────────────────────────────────────────────────
  const tbodyTrocas = document.getElementById('tbody-trocas');
  if (trocas?.length) {
    tbodyTrocas.innerHTML = trocas.map(t => {
      const serial = t.serial_anterior ?? t.pn_anterior ?? '—';
      const serialNovo = t.serial_novo ?? t.pn_novo ?? '—';
      const pctAntes   = t.percentual_antes  != null ? `<span class="text-${t.percentual_antes  < 10 ? 'danger' : t.percentual_antes  < 20 ? 'warning' : 'secondary'}">${t.percentual_antes}%</span>` : '—';
      const pctDepois  = t.percentual_depois != null ? `<span class="text-${t.percentual_depois < 10 ? 'danger' : t.percentual_depois < 20 ? 'warning' : 'success'}">${t.percentual_depois}%</span>` : '—';
      return `
        <tr>
          <td class="text-muted small">${formatarDataHora(t.ocorrido_em)}</td>
          <td class="fw-medium">${t.nome}</td>
          <td><code class="text-danger small">${serial}</code></td>
          <td><code class="text-success small">${serialNovo}</code></td>
          <td>${pctAntes}</td>
          <td>${pctDepois}</td>
          <td>${t.paginas_anterior?.toLocaleString('pt-BR') ?? '—'}</td>
        </tr>`;
    }).join('');
  }
}

// ─── Botão de atualizar ──────────────────────────────────────────────────────
document.getElementById('btn-refresh')?.addEventListener('click', () => carregar());

// ─── Carga inicial ────────────────────────────────────────────────────────────
carregar();
