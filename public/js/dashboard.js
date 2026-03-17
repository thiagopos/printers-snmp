// ─── Mapeamento prédio → rótulo amigável ─────────────────────────────────────
const PREDIO_LABEL = {
  'hmacn_internacao':    'Hospital',
  'hmacn_administracao': 'Administração',
};
function labelPredio(predio) {
  if (!predio) return '—';
  return PREDIO_LABEL[predio] ?? predio;
}

// ─── Mapeamento modelo → imagem ───────────────────────────────────────────────
const MODELO_IMG = {
  'Samsung M4020': 'img/impressoras/m4020.png',
  'HP E52645':     'img/impressoras/e52645.png',
  'HP 408dn':      'img/impressoras/408dn.png',
  'HP E57540 Cor': 'img/impressoras/e57540.png',
  'HP E87660 A3':  'img/impressoras/e87660.png',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function corToner(nome) {
  const n = nome.toLowerCase();
  if (n.includes('preto') || n.includes('cartucho')) return '#2c2c2c';
  if (n.includes('ciano'))   return '#0891b2';
  if (n.includes('magenta')) return '#be185d';
  if (n.includes('amarelo')) return '#ca8a04';
  return '#6c757d';
}

function classePercentual(pct) {
  if (pct == null) return 'secondary';
  if (pct <  5)   return 'danger';
  if (pct < 20)   return 'warning';
  return 'success';
}

function timeAgo(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr).getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d atrás`;
  if (h > 0) return `${h}h atrás`;
  if (m > 0) return `${m}min atrás`;
  return 'agora';
}

function ehTonerPuro(nome) {
  const n = nome.toLowerCase();
  if (n.includes('unidade') || n.includes('coleta')) return false;
  return n.includes('toner') || n.includes('cartucho');
}

function ordemToner(nome) {
  const n = nome.toLowerCase();
  if (n.includes('preto') || n.includes('black') || n.includes('cartucho')) return 0;
  if (n.includes('ciano')   || n.includes('cyan'))    return 1;
  if (n.includes('magenta'))                           return 2;
  if (n.includes('amarelo') || n.includes('yellow'))  return 3;
  return 4;
}

function renderTonerBadges(consumiveis) {
  const toners = consumiveis
    .filter(c => ehTonerPuro(c.nome))
    .sort((a, b) => ordemToner(a.nome) - ordemToner(b.nome));
  if (!toners.length) return '<span class="text-muted">—</span>';

  return toners.map(t => {
    const cor = corToner(t.nome);
    const pct = t.percentual ?? '?';
    const cls = classePercentual(t.percentual);
    return `<span class="toner-badge border border-${cls}" style="background:${cor}" title="${t.nome}: ${pct}%">${pct}%</span>`;
  }).join(' ');
}

function renderTempoEstimado(consumiveis, diasRestantes) {
  // Mostra o preto/cartucho; fallback para o toner com menor tempo
  const toners = consumiveis
    .filter(c => ehTonerPuro(c.nome))
    .sort((a, b) => ordemToner(a.nome) - ordemToner(b.nome));
  if (!toners.length) return '<span class="text-muted">—</span>';

  // Coleta previsões disponíveis (só preto para mono; todos os cores)
  const previsoes = toners
    .map(t => ({ nome: t.nome, pct: t.percentual, dias: diasRestantes[t.nome] ?? null, ordem: ordemToner(t.nome) }))
    .filter(t => t.dias != null);

  if (!previsoes.length) return '<span class="text-muted">—</span>';

  // Prioriza o preto; se não tiver, usa o menor
  const alvo = previsoes.find(t => t.ordem === 0)
             ?? previsoes.reduce((a, b) => a.dias < b.dias ? a : b);

  const cls  = classePercentual(alvo.pct);
  let   icon, label;
  if (alvo.dias <= 7)  { icon = 'bi-alarm-fill';     label = 'text-danger'; }
  else if (alvo.dias <= 30) { icon = 'bi-clock-history'; label = 'text-warning'; }
  else                { icon = 'bi-clock';            label = 'text-success'; }

  return `
    <div class="d-flex align-items-center gap-2">
      <i class="bi ${icon} ${label}" style="font-size:1.1rem"></i>
      <div>
        <div class="fw-semibold text-${cls}">~${alvo.dias}d</div>
        <div class="text-muted" style="font-size:.78rem">${alvo.nome.split(' ').slice(-1)[0]}</div>
      </div>
    </div>`;
}

// ─── Estado de ordenação (persistido por sessão) ─────────────────────────────────
let dadosImpressoras = [];
let sortCol = sessionStorage.getItem('sortCol') ?? null;
let sortDir = parseInt(sessionStorage.getItem('sortDir') ?? '1');

function tonerPreto(consumiveis) {
  // Busca o toner preto explicitamente; fallback para o menor toner disponível
  const toners = consumiveis.filter(c => ehTonerPuro(c.nome));
  if (!toners.length) return 999;
  const preto = toners.find(c => {
    const n = c.nome.toLowerCase();
    return n.includes('preto') || n.includes('black') || n.includes('cartucho');
  });
  if (preto) return preto.percentual ?? 999;
  return Math.min(...toners.map(t => t.percentual ?? 999));
}

function tempoEstimadoDias(consumiveis, diasRestantes) {
  const toners = consumiveis.filter(c => ehTonerPuro(c.nome));
  const preto  = toners.find(t => ordemToner(t.nome) === 0);
  if (preto && diasRestantes[preto.nome] != null) return diasRestantes[preto.nome];
  const vals = toners.map(t => diasRestantes[t.nome]).filter(v => v != null);
  return vals.length ? Math.min(...vals) : 9999;
}

function pesoStatus(imp, hoje) {
  // Menor peso = aparece primeiro quando dir=1 (ascendente)
  // 0 = trocada  1 = backup  2 = offline  3 = alerta  4 = online
  if (imp.status_serie === 'trocada') return 0;
  if (imp.status_serie === 'backup')  return 1;
  const online = imp.coletado_em?.slice(0, 10) === hoje;
  if (!online)                        return 2;
  const temAlertaOuZero = !!([imp.alerta, imp.mensagem_tela]
    .filter(v => v && v.trim().replace(/\/$/, '').toLowerCase() !== 'pronto').join(''))
    || imp.consumiveis.some(c => ehTonerPuro(c.nome) && c.percentual === 0);
  if (temAlertaOuZero)                return 3;
  return 4;
}

function sortarImpressoras(lista) {
  if (!sortCol) return lista;
  return [...lista].sort((a, b) => {
    switch (sortCol) {
      case 'modelo':  return sortDir * (a.modelo ?? '').localeCompare(b.modelo ?? '', 'pt-BR');
      case 'predio':  return sortDir * (a.local?.predio ?? '').localeCompare(b.local?.predio ?? '', 'pt-BR');
      case 'andar':   return sortDir * ((a.local?.andar ?? -1) - (b.local?.andar ?? -1));
      case 'setor':   return sortDir * (a.local?.nome_setor ?? a.setor ?? '').localeCompare(b.local?.nome_setor ?? b.setor ?? '', 'pt-BR');
      case 'local':   return sortDir * (a.local?.local_instalacao ?? '').localeCompare(b.local?.local_instalacao ?? '', 'pt-BR');
      case 'toner':   return sortDir * (tonerPreto(a.consumiveis) - tonerPreto(b.consumiveis));
      case 'tempo':   return sortDir * (tempoEstimadoDias(a.consumiveis, a.dias_restantes ?? {}) - tempoEstimadoDias(b.consumiveis, b.dias_restantes ?? {}));
      case 'status': {
        const hoje = new Date().toISOString().slice(0, 10);
        return sortDir * (pesoStatus(a, hoje) - pesoStatus(b, hoje));
      }
      default: return 0;
    }
  });
}

function atualizarHeadersSort() {
  document.querySelectorAll('.th-sort').forEach(th => {
    th.classList.remove('th-ativo');
    const icon = th.querySelector('i');
    if (icon) icon.className = 'bi bi-arrow-down-up';
    if (th.dataset.col === sortCol) {
      th.classList.add('th-ativo');
      if (icon) icon.className = sortDir === 1 ? 'bi bi-arrow-up' : 'bi bi-arrow-down';
    }
  });
}

function aplicarFiltroESort() {
  const q = document.getElementById('filtro').value.toLowerCase();
  let lista = dadosImpressoras;
  if (q) lista = lista.filter(imp =>
    (imp.modelo + ' ' + (imp.local?.nome_setor ?? imp.setor) + ' ' + (imp.local?.predio ?? '') + ' ' + (imp.local?.andar ?? '') + ' ' + (imp.local?.local_instalacao ?? '') + ' ' + (imp.serie_snmp ?? '')).toLowerCase().includes(q)
  );
  renderTabela(sortarImpressoras(lista));
  atualizarHeadersSort();
}

// ─── Período ativo (persistido por sessão) ────────────────────────────────────────────────
const LABELS_PERIODO = {
  total:     '— Páginas totais',
  mes:       '— Últimos 30 dias',
  semana:    '— Últimos 7 dias',
  intervalo: '',            // preenchido dinamicamente
};
let periodoAtual   = sessionStorage.getItem('periodo') ?? 'semana';
let intervaloAtivo = false; // true quando o usuário aplicou datas livres

function labelIntervalo(de, ate) {
  const fmt = s => s.split('-').reverse().join('/');
  return `— ${fmt(de)} a ${fmt(ate)}`;
}

function atualizarBotoesPeriodo(de, ate) {
  document.querySelectorAll('.periodo-btn').forEach(btn => {
    btn.classList.toggle('active', !intervaloAtivo && btn.dataset.periodo === periodoAtual);
  });
  const el = document.getElementById('label-periodo');
  if (!el) return;
  if (intervaloAtivo && de && ate) {
    el.textContent = labelIntervalo(de, ate);
  } else {
    el.textContent = LABELS_PERIODO[periodoAtual] ?? '';
  }
}

// ─── Instâncias de Chart ──────────────────────────────────────────────────────
let chartDonut   = null;
let chartPaginas = null;
let impressorasTop = []; // dados {id, setor, modelo} das impressoras exibidas no gráfico

function renderCards(s) {
  document.getElementById('card-total').textContent    = s.total + ' / ' + s.total_config;
  document.getElementById('card-resmas').textContent   = s.resmas_semana ?? '—';
  document.getElementById('card-atencao').textContent  = s.atencao;
  document.getElementById('card-criticos').textContent = s.criticos;
}

function renderDonut(s) {
  const ctx  = document.getElementById('chart-donut').getContext('2d');
  const data = {
    labels:   ['OK (≥20%)', 'Atenção (5–20%)', 'Crítico (<5%)'],
    datasets: [{ data: [s.ok, s.atencao, s.criticos],
      backgroundColor: ['#198754', '#f59e0b', '#dc3545'], borderWidth: 2 }],
  };
  if (chartDonut) { Object.assign(chartDonut.data, data); chartDonut.update(); return; }
  chartDonut = new Chart(ctx, {
    type: 'doughnut', data,
    options: { cutout: '65%', plugins: { legend: { position: 'bottom' } } },
  });
}

function renderBarPaginas(top) {
  impressorasTop = top; // atualiza sempre para que o onClick use dados frescos
  const ctx    = document.getElementById('chart-paginas').getContext('2d');
  const labels = top.map(r => {
    const setor = r.nome_setor ?? r.setor;
    const label = r.local_instalacao ? setor + ' — ' + r.local_instalacao : setor;
    return label.length > 38 ? label.slice(0, 38) + '…' : label;
  });
  const data   = {
    labels,
    datasets: [{ label: 'Total de Páginas', data: top.map(r => r.total_paginas),
      backgroundColor: '#3b82f6', hoverBackgroundColor: '#2563eb', borderRadius: 4 }],
  };
  if (chartPaginas) { Object.assign(chartPaginas.data, data); chartPaginas.update(); return; }
  chartPaginas = new Chart(ctx, {
    type: 'bar', data,
    options: {
      indexAxis: 'y',
      onClick: (_evt, elements) => {
        if (!elements.length) return;
        const imp = impressorasTop[elements[0].index];
        if (imp) location.href = `impressora.html?id=${imp.id}`;
      },
      plugins: {
        legend: { display: false },
        datalabels: {
          anchor: 'end',
          align: 'end',
          color: '#1e40af',
          font: { size: 13, weight: '700', family: 'system-ui, sans-serif' },
          backgroundColor: 'rgba(219,234,254,0.85)',
          borderRadius: 4,
          padding: { top: 2, bottom: 2, left: 5, right: 5 },
          formatter: v => v.toLocaleString('pt-BR'),
        },
      },
      scales: {
        x: { ticks: { font: { size: 13 } } },
        y: { ticks: { font: { size: 13 } } },
      },
      layout: { padding: { right: 72 } },
    },
  });

  // Cursor pointer ao passar sobre as barras
  document.getElementById('chart-paginas').style.cursor = 'pointer';
}

function renderTabela(impressoras) {
  const hoje  = new Date().toISOString().slice(0, 10);
  const tbody = document.getElementById('tbody-impressoras');

  tbody.innerHTML = impressoras.map(imp => {
    const online  = imp.coletado_em?.slice(0, 10) === hoje;
    const temErro = imp.status_serie === 'trocada'
      || !!([imp.alerta, imp.mensagem_tela].filter(v => v && v.trim().replace(/\/$/, '').toLowerCase() !== 'pronto').join(''))
      || imp.consumiveis.some(c => ehTonerPuro(c.nome) && c.percentual === 0);
    const img     = temErro ? 'img/impressoras/error.png' : (MODELO_IMG[imp.modelo] ?? '');
    const badges  = renderTonerBadges(imp.consumiveis);
    const tempo   = renderTempoEstimado(imp.consumiveis, imp.dias_restantes ?? {});
    const predio  = labelPredio(imp.local?.predio);
    const andar   = imp.local?.andar           ?? '—';
    const setor   = imp.local?.nome_setor      ?? imp.setor ?? '—';
    const local   = imp.local?.local_instalacao ?? '—';

    const alertaTexto = [imp.alerta, imp.mensagem_tela]
      .filter(v => v && v.trim().replace(/\/$/, '').toLowerCase() !== 'pronto')
      .join(' | ');

    const trTitle = alertaTexto ? ` title="${alertaTexto.replace(/"/g, '&quot;')}" style="cursor:help"` : '';

    const statusBadge = (() => {
      const s = imp.status_serie;
      if (s === 'backup') {
        const nome  = imp.serie_info?.backup_nome ?? '';
        const atual = imp.serie_info?.atual ?? '?';
        const title = (nome ? `${nome} — ` : '') + `S/N: ${atual}`;
        return `<span class="badge-serie-backup" title="${title}"><i class="bi bi-arrow-repeat me-1"></i>Backup</span>`;
      }
      if (s === 'trocada') {
        const atual = imp.serie_info?.atual ?? '?';
        const esper = imp.serie_info?.esperada ?? '?';
        return `<span class="badge-serie-trocada" title="S/N atual: ${atual} — esperado: ${esper}"><i class="bi bi-exclamation-diamond-fill me-1"></i>Trocada</span>`;
      }
      if (!online) {
        return '<span class="badge bg-secondary bg-opacity-10 text-secondary border"><i class="bi bi-wifi-off me-1"></i>Offline</span>';
      }
      const temAlertaOuZero = alertaTexto
        || imp.consumiveis.some(c => ehTonerPuro(c.nome) && c.percentual === 0);
      return temAlertaOuZero
        ? `<span class="badge bg-warning bg-opacity-10 text-warning border border-warning"><i class="bi bi-exclamation-triangle-fill me-1"></i>Alerta</span>`
        : '<span class="badge bg-success bg-opacity-10 text-success border border-success"><i class="bi bi-circle-fill me-1" style="font-size:.5rem"></i>Online</span>';
    })();

    return `
      <tr onclick="location.href='impressora.html?id=${imp.id}'"${trTitle}>
        <td>
          <div class="d-flex align-items-center gap-2">
            <img src="${img}" alt="${imp.modelo}" width="40" height="40"
                 style="object-fit:contain;border-radius:4px"
                 onerror="this.style.visibility='hidden'">
            <span class="fw-medium">${imp.modelo}</span>
          </div>
        </td>
        <td class="text-muted font-monospace" style="font-size:.8rem">${imp.serie_snmp ?? '—'}</td>
        <td class="text-muted col-oculta-mobile">${predio}</td>
        <td class="text-muted col-oculta-mobile">${andar}</td>
        <td class="text-muted">${setor}</td>
        <td class="text-muted col-oculta-mobile">${local}</td>
        <td>${badges}</td>
        <td class="col-oculta-mobile">${tempo}</td>
        <td>${statusBadge}</td>
        <td onclick="event.stopPropagation()">
          <a href="http://${imp.ip_liberty}" target="_blank" rel="noopener noreferrer"
             class="btn btn-sm btn-outline-secondary" title="Abrir página web da impressora">
            <i class="bi bi-box-arrow-up-right"></i>
          </a>
        </td>
      </tr>`;
  }).join('');
}

// ─── Cache local (stale-while-revalidate) ────────────────────────────────────
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

function _cacheKeySummary() {
  if (intervaloAtivo) {
    const de  = document.getElementById('filtro-de').value;
    const ate = document.getElementById('filtro-ate').value;
    return `cache_summary_${de}_${ate}`;
  }
  return `cache_summary_${periodoAtual}`;
}

function salvarCache(tipo, dados) {
  try {
    const key = tipo === 'impressoras' ? 'cache_impressoras' : _cacheKeySummary();
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), dados }));
  } catch {}
}

function lerCache(tipo) {
  try {
    const key = tipo === 'impressoras' ? 'cache_impressoras' : _cacheKeySummary();
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { ts, dados } = JSON.parse(raw);
    return Date.now() - ts <= CACHE_TTL_MS ? dados : null;
  } catch { return null; }
}

function setLoadingGraficos(ativo) {
  ['overlay-donut', 'overlay-paginas'].forEach(id => {
    document.getElementById(id)?.classList.toggle('oculto', !ativo);
  });
}

// ─── Carga e atualização ──────────────────────────────────────────────────────
async function carregarTudo() {
  let summaryUrl = `/api/summary?periodo=${periodoAtual}`;
  if (intervaloAtivo) {
    const de  = document.getElementById('filtro-de').value;
    const ate = document.getElementById('filtro-ate').value;
    if (de && ate) summaryUrl = `/api/summary?de=${de}&ate=${ate}`;
  }

  // Renderiza do cache imediatamente — sem esperar a rede
  const cacheSummary     = lerCache('summary');
  const cacheImpressoras = lerCache('impressoras');

  if (cacheSummary && cacheImpressoras) {
    dadosImpressoras = cacheImpressoras;
    renderCards(cacheSummary);
    renderDonut(cacheSummary);
    renderBarPaginas(cacheSummary.top_paginas);
    atualizarBotoesPeriodo(cacheSummary.de, cacheSummary.ate);
    aplicarFiltroESort();
  } else {
    // Sem cache: mostra overlay enquanto carrega
    setLoadingGraficos(true);
  }

  // Busca dados frescos (em background se havia cache)
  try {
    const [summary, impressoras] = await Promise.all([
      fetch(summaryUrl).then(r => r.json()),
      fetch('/api/impressoras').then(r => r.json()),
    ]);

    salvarCache('summary', summary);
    salvarCache('impressoras', impressoras);

    dadosImpressoras = impressoras;
    renderCards(summary);
    renderDonut(summary);
    renderBarPaginas(summary.top_paginas);
    atualizarBotoesPeriodo(summary.de, summary.ate);
    aplicarFiltroESort();

    document.getElementById('ultima-atualizacao').textContent =
      'Atualizado: ' + new Date().toLocaleTimeString('pt-BR');
  } finally {
    setLoadingGraficos(false);
  }
}

// ─── Filtro da tabela ─────────────────────────────────────────────────────────
document.getElementById('filtro').addEventListener('input', () => aplicarFiltroESort());

// ─── Ordenação por coluna ─────────────────────────────────────────────────────
document.querySelectorAll('.th-sort').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (sortCol === col) { sortDir *= -1; } else { sortCol = col; sortDir = 1; }
    sessionStorage.setItem('sortCol', sortCol);
    sessionStorage.setItem('sortDir', sortDir);
    aplicarFiltroESort();
  });
});

// ─── Seletor de período ────────────────────────────────────────────────────────
document.querySelectorAll('.periodo-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!intervaloAtivo && btn.dataset.periodo === periodoAtual) return;
    periodoAtual   = btn.dataset.periodo;
    intervaloAtivo = false;
    sessionStorage.setItem('periodo', periodoAtual);
    if (chartPaginas) { chartPaginas.destroy(); chartPaginas = null; }
    carregarTudo();
  });
});

// ─── Filtro de intervalo livre ───────────────────────────────────────────────
document.getElementById('btn-aplicar-intervalo')?.addEventListener('click', () => {
  const de  = document.getElementById('filtro-de').value;
  const ate = document.getElementById('filtro-ate').value;
  if (!de || !ate) return;
  if (de > ate) { alert('A data de início deve ser anterior à data de fim.'); return; }
  intervaloAtivo = true;
  if (chartPaginas) { chartPaginas.destroy(); chartPaginas = null; }
  carregarTudo();
});

// ─── Botão expandir setores ──────────────────────────────────────────────────
document.getElementById('btn-expandir-setores')?.addEventListener('click', () => {
  let url = 'todos-setores.html';
  if (intervaloAtivo) {
    const de  = document.getElementById('filtro-de').value;
    const ate = document.getElementById('filtro-ate').value;
    if (de && ate) url += `?de=${de}&ate=${ate}`;
  } else {
    url += `?periodo=${periodoAtual}`;
  }
  location.href = url;
});

// ─── Botão de atualizar ──────────────────────────────────────────────────────
document.getElementById('btn-refresh')?.addEventListener('click', () => carregarTudo());

// ─── Carga inicial ────────────────────────────────────────────────────────────
carregarTudo();
