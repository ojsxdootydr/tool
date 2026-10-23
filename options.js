const $ = id => document.getElementById(id);
const PADRAO = { apiKey: '', idioma: 'pt', modeloResumo: 'claude-haiku-5-5', modeloCheck: 'claude-haiku-5-5', turbo: false };
// a pagina segue a lingua escolhida em "Traduzir para" (textos em idiomas.js); muda na hora ao trocar a lingua
let lingua = 'pt';
const T = (chave, a, b) => textoUI(lingua, chave, a, b);
const MODELOS = () => [['claude-haiku-5-5', T('m_h55')], ['claude-haiku-4-5-20251001', T('m_h45')], ['claude-sonnet-5-5', T('m_s55')]];
$('idi').innerHTML = Object.entries(IDIOMAS).map(([cod, l]) => '<option value="' + cod + '">' + l.nome + '</option>').join('');

function preencherModelos(sel, valor) {
  const base = MODELOS(), lista = base.some(([id]) => id === valor) ? base : base.concat([[valor, valor]]);   // mantem um modelo personalizado salvo antes
  sel.innerHTML = lista.map(([id, nome]) => '<option value="' + id + '">' + nome + '</option>').join('');
  sel.value = valor;
}
function aplicarTextos() {
  document.documentElement.lang = lingua === 'pt' ? 'pt-BR' : TEXTOS[lingua] ? lingua : 'en';
  document.querySelectorAll('[data-t]').forEach(el => { el.textContent = T(el.dataset.t); });
  document.querySelectorAll('[data-th]').forEach(el => { el.innerHTML = T(el.dataset.th); });
  $('ver').textContent = T($('chave').type === 'password' ? 'o_show' : 'o_hide');
  preencherModelos($('mr'), $('mr').value || PADRAO.modeloResumo); preencherModelos($('mc'), $('mc').value || PADRAO.modeloCheck);
  desenhar();   // tabela de gasto na lingua escolhida
  try { desenharLupas(); } catch (e) {}
}
chrome.storage.local.get(PADRAO, c => {
  lingua = IDIOMAS[c.idioma] ? c.idioma : 'pt';
  $('chave').value = c.apiKey; $('idi').value = lingua; $('turbo').checked = c.turbo === true;
  preencherModelos($('mr'), c.modeloResumo); preencherModelos($('mc'), c.modeloCheck);
  aplicarTextos();
});
// botao "ler noticias (todos os sites)": pede ou retira a permissao na hora do clique (precisa do gesto do usuario)
const TODOS = { origins: ['https://*/*'] };
const refletirSites = () => { try { chrome.permissions.contains(TODOS, ok => { void chrome.runtime.lastError; $('sites').checked = !!ok; }); } catch (e) {} };
$('sites').onchange = () => {
  if ($('sites').checked) {
    chrome.permissions.request(TODOS, ok => { void chrome.runtime.lastError; $('sites').checked = !!ok; try { chrome.storage.local.set({ lerSites: !!ok }); } catch (e) {} });
  } else {
    chrome.permissions.remove(TODOS, () => { void chrome.runtime.lastError; $('sites').checked = false; try { chrome.storage.local.set({ lerSites: false }); } catch (e) {} });
  }
};
refletirSites();
$('idi').onchange = () => { lingua = $('idi').value; aplicarTextos(); };
$('ver').onclick = () => { const i = $('chave'); i.type = i.type === 'password' ? 'text' : 'password'; $('ver').textContent = T(i.type === 'password' ? 'o_show' : 'o_hide'); };
$('salvar').onclick = () => {
  chrome.storage.local.set({ apiKey: $('chave').value.trim(), idioma: $('idi').value, modeloResumo: $('mr').value, modeloCheck: $('mc').value, turbo: $('turbo').checked },
    () => { $('ok').classList.add('on'); setTimeout(() => $('ok').classList.remove('on'), 2000); });
};
// ---- medidor de gasto: por funcao (resumo, analise da lupa, resumo de pagina, perguntas), por periodo, e as ultimas chamadas ----
const FUNCOES = ['resumo', 'verificacao', 'explicar', 'pergunta_tweet', 'pergunta_pagina', 'outros'];
const nomeDe = f => FUNCOES.includes(f) ? T('n_' + f) : f;
const mil = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
function desenhar() {
  chrome.storage.local.get({ uso: {} }, ({ uso }) => {
    const dias = parseInt($('per').value, 10), corte = new Date(Date.now() - (dias - 1) * 864e5).toISOString().slice(0, 10);
    const tot = {};
    for (const [dia, fs] of Object.entries(uso)) { if (dia < corte) continue; for (const [f, v] of Object.entries(fs)) { const t = tot[f] = tot[f] || { n: 0, i: 0, o: 0, b: 0, c: 0 }; for (const k of Object.keys(t)) t[k] += v[k] || 0; } }
    const custoTotal = Object.values(tot).reduce((s, t) => s + t.c, 0);
    $('grande').innerHTML = 'US$ ' + custoTotal.toFixed(custoTotal < 1 ? 3 : 2) + '<small>' + $('per').selectedOptions[0].textContent + '</small>';
    let html = '<tr><th>' + T('o_hFeature') + '</th><th></th><th>' + T('o_hUses') + '</th><th>' + T('o_hSearches') + '</th><th>' + T('o_hTokens') + '</th><th>' + T('o_hTotal') + '</th><th>' + T('o_hPer') + '</th></tr>';
    const soma = { n: 0, b: 0, t: 0, c: 0 };
    for (const f of FUNCOES) {
      const t = tot[f]; if (!t) continue;
      html += '<tr><td>' + nomeDe(f) + '</td><td><div class="barra"><i style="width:' + (custoTotal ? Math.max(3, Math.round(t.c / custoTotal * 100)) : 0) + '%"></i></div></td><td>' + t.n + '</td><td>' + t.b + '</td><td>' + mil(t.i + t.o) + '</td><td>' + t.c.toFixed(3) + '</td><td>' + (t.c / t.n).toFixed(4) + '</td></tr>';
      soma.n += t.n; soma.b += t.b; soma.t += t.i + t.o; soma.c += t.c;
    }
    html += '<tr class="tot"><td>' + T('o_total') + '</td><td></td><td>' + soma.n + '</td><td>' + soma.b + '</td><td>' + mil(soma.t) + '</td><td>' + soma.c.toFixed(3) + '</td><td></td></tr>';
    $('tb').innerHTML = soma.n ? html : '<tr><td class="vazio">' + T('o_noUsage') + '</td></tr>';
  });
  chrome.storage.local.get({ usolog: [] }, ({ usolog }) => {
    const quando = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? T('o_now') : m < 60 ? m + ' min' : m < 1440 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d'; };
    let h = '<tr><th>' + T('o_hWhen') + '</th><th>' + T('o_hFeature') + '</th><th>' + T('o_hIn') + '</th><th>' + T('o_hOut') + '</th><th>' + T('o_hSearches') + '</th><th>' + T('o_hTime') + '</th><th>US$</th></tr>';
    for (const e of usolog.slice(-40).reverse()) h += '<tr><td>' + quando(e.t) + '</td><td>' + nomeDe(e.f) + '</td><td>' + e.i + '</td><td>' + e.o + '</td><td>' + e.b + '</td><td>' + (e.ms / 1000).toFixed(1) + ' s</td><td>' + e.c.toFixed(4) + '</td></tr>';
    $('lg').innerHTML = usolog.length ? h : '<tr><td class="vazio">' + T('o_noCalls') + '</td></tr>';
  });
}
$('per').onchange = desenhar;
$('zerar').onclick = () => { if (confirm(T('o_clearConfirm'))) chrome.storage.local.set({ uso: {}, usolog: [], lupalog: [] }, () => { desenhar(); desenharLupas(); }); };
const EST = { verdadeiro: 'vTrue', falso: 'vFalse', parcial: 'vPartly', nao_confirmado: 'vUnconfirmed', nao_verificavel: 'vUnverifiable' };
function desenharLupas() {
  chrome.storage.local.get({ lupalog: [] }, ({ lupalog }) => {
    const esc = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const quando = t => new Date(t).toLocaleString(lingua === 'pt' ? 'pt-BR' : lingua, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    $('lupas').innerHTML = lupalog.length ? lupalog.slice().reverse().map(e =>
      '<details><summary>' + esc(quando(e.t)) + ' · <b>' + esc(T(EST[e.veredito] || 'vUnconfirmed')) + '</b> · ' + esc((e.manchete || e.texto.slice(0, 60)).replace(/\*\*/g, '')) + (e.autor ? ' <small>@' + esc(e.autor) + '</small>' : '') + '</summary>' +
      '<div class="tw">' + (/^[\w]{1,15}\/\d{15,20}$/.test(e.status) ? '<a href="https://x.com/' + esc(e.status) + '" target="_blank" rel="noopener">' + esc(e.texto) + '</a>' : esc(e.texto)) + '</div>' +
      rastroHtml(e.rastro, lingua, true) + '</details>').join('') : '<span class="vazio">' + esc(T('rs_noHist')) + '</span>';
  });
}
desenharLupas();
chrome.storage.onChanged.addListener(c => { if (c.uso || c.usolog) desenhar(); if (c.lupalog) desenharLupas(); });
desenhar();
