// Faz o trabalho pesado em segundo plano: busca o texto do tweet e traduz.
importScripts('termos.js', 'conhecimento_base.js', 'idiomas.js');   // girias que nao se traduz, base de memecoins, linguas
// ao atualizar: apaga configuracoes de funcoes que foram removidas (DeepL, Groq, servidor local, pre-traducao, traducao pelo Claude, "seu conhecimento")
chrome.runtime.onInstalled.addListener(d => { if (d.reason === 'update') chrome.storage.local.remove(['deeplKey', 'groqKey', 'modeloGroq', 'verificarComClaude', 'servidorLocal', 'prefetchLigado', 'traducaoClaude', 'conhecimento']); });
const cache = new Map();          // texto normalizado -> traducao
// cache que sobrevive ao reinicio do service worker (economiza cota)
let salvarTimer = null;
// lingua de destino (configuracoes > "Traduzir para"); as traducoes e as respostas da IA saem nela
let idioma = 'pt';
// cache antigo (sem a lingua na chave) e descartado uma vez
const carregado = new Promise(pronto => chrome.storage.local.get({ tcache: [], tcacheV: 0, idioma: 'pt' }, c => {
  idioma = IDIOMAS[c.idioma] ? c.idioma : 'pt';
  if (c.tcacheV !== 5) chrome.storage.local.set({ tcache: [], tcacheV: 5 });
  else try { (c.tcache || []).forEach(([k, v]) => cache.set(k, v)); } catch (e) {}
  pronto();
}));
chrome.storage.onChanged.addListener(ch => {
  if (ch.idioma) idioma = IDIOMAS[ch.idioma.newValue] ? ch.idioma.newValue : 'pt';
});
// instrucoes do Claude foram escritas em portugues: troca a lingua da resposta pela escolhida
// texto da interface (mensagens de erro, menu do botao direito) na lingua escolhida; os textos ficam em idiomas.js
const T = (chave, a, b) => textoUI(idioma, chave, a, b);
// resposta de erro para a pagina: mensagem na lingua escolhida + aviso de que falta a chave (a pagina mostra o link das configuracoes)
const respostaDeErro = e => ({ ok: false, erro: erroAmigavel(e), semChave: String(e && e.message) === 'SEM_CHAVE' });
function naLingua(sistema) {
  if (idioma === 'pt' || typeof sistema !== 'string') return sistema;
  const nome = idiomaDe(idioma).ia;
  return sistema.replace(/portugues do Brasil|Brazilian Portuguese/gi, nome).replace(/trader brasileiro/gi, 'trader') +
    '\n\nIDIOMA: escreva TODA a resposta em ' + nome + ' (o texto dos campos), mesmo que as instrucoes estejam em portugues. ' +
    'Nomes de campos JSON, valores de veredito e rotulos fixos de linha ("Resumo:", "Vale a pena:", "Da pra fazer:", "Cara de IA:") e as palavras ' +
    'logo depois deles (sim, talvez, nao, dificil, alta, media, baixa) continuam exatamente em portugues, porque a extensao le esses rotulos. ' +
    'Isso vale so para esses rotulos: nos campos narrativa e checagem tudo vem em ' + nome + ', inclusive a resposta do inicio (Sim/Nao).';
}
function agendarSalvar() {
  if (salvarTimer) return;
  salvarTimer = setTimeout(() => { salvarTimer = null; try { chrome.storage.local.set({ tcache: Array.from(cache.entries()).slice(-600) }); } catch (e) {} }, 4000);
}
const emAndamento = new Map();    // texto normalizado -> promessa
let ultimoErro = '';

const norm = t => String(t).replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// ---- tradutores online ----
// O Google bloqueia (erro 429) quando recebe muitos pedidos seguidos. Por isso os textos sao juntados em LOTES:
// todos os pedacos de um balao vao num pedido so, e um lote de cada vez. Microsoft e Lingva sairam (fecharam o acesso gratis).
const folga = {}, falhas = {};   // tradutor -> ate quando fica de molho / quantas falhas seguidas
function erroHttp(nome, r) { const e = new Error(nome + ' HTTP ' + r.status); e.status = r.status; return e; }
const deMolho = nome => (folga[nome] || 0) > Date.now();
function falhou(nome, e) {
  const st = e && e.status, n = falhas[nome] = (falhas[nome] || 0) + 1;
  const espera = st === 404 ? 6 * 3600e3 : st === 403 ? 30 * 60e3 : st === 429 ? Math.min(10 * 60e3, 30e3 * Math.pow(2, n - 1)) : 15e3;
  folga[nome] = Date.now() + espera;
  console.log('[Axiom Helper] translator ' + nome + ' failed (' + ((e && e.message) || e) + '), paused for ' + Math.round(espera / 1000) + ' s');
}

// Google em lote: o endereco translate_a/t aceita varios "q" num pedido so e devolve uma traducao para cada
async function googleLote(textos, lingua) {
  const r = await fetch('https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=' + idiomaDe(lingua).google + '&format=text', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: textos.map(t => 'q=' + encodeURIComponent(t)).join('&'), signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw erroHttp('Google', r);
  const j = await r.json();
  // resposta (conferida): [["traducao","en"], ...], uma por texto, inclusive com 1 texto so ([["Olá mundo","en"]]).
  // Por seguranca aceita tambem ["traducao","en"] ou "traducao" quando ha 1 texto.
  const lista = textos.length === 1 && !(Array.isArray(j) && j.length === 1) ? [j] : j;
  if (!Array.isArray(lista) || lista.length !== textos.length) throw new Error('Google: unexpected batch response');
  return lista.map(x => String((Array.isArray(x) ? x[0] : x) || ''));
}
// MyMemory: fraco e com limite diario, so para textos curtos quando o Google esta bloqueado
async function mymemory(texto, lingua) {
  const r = await fetch('https://api.mymemory.translated.net/get?langpair=' + encodeURIComponent('Autodetect|' + idiomaDe(lingua).mymemory) + '&q=' + encodeURIComponent(texto.slice(0, 450)), { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw erroHttp('MyMemory', r);
  const j = await r.json();
  const t = j.responseData && j.responseData.translatedText;
  if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(t)) throw new Error('MyMemory refused');
  return t;
}
async function traduzirLote(textos, lingua) {
  const erros = [];
  if (!deMolho('google')) {
    try { const r = await googleLote(textos, lingua); falhas.google = 0; return r; }
    catch (e) { erros.push(e.message); falhou('google', e); }
  } else erros.push('Google bloqueado por excesso de pedidos, volta em ' + Math.ceil((folga.google - Date.now()) / 1000) + ' s');
  if (!deMolho('mymemory') && textos.every(t => t.length <= 450)) {
    try { const r = []; for (const t of textos) r.push(await mymemory(t, lingua)); falhas.mymemory = 0; return r; }
    catch (e) { erros.push(e.message); falhou('mymemory', e); }
  }
  throw new Error(erros.join(' | ') || 'nenhum tradutor disponivel');
}
// fila de lotes: junta os pedidos que chegam em 60 ms (os pedacos de um balao) e manda um lote de cada vez
const pendentes = []; let timerLote = null, rodandoLote = false;
function pedirTraducao(texto, lingua) {
  return new Promise((ok, erro) => {
    pendentes.push({ texto, lingua, ok, erro });
    if (!timerLote && !rodandoLote) timerLote = setTimeout(esvaziarFila, 60);
  });
}
async function esvaziarFila() {
  timerLote = null; rodandoLote = true;
  try {
    while (pendentes.length) {
      // ate 25 textos / 3500 caracteres por pedido, todos para a mesma lingua
      const lingua = pendentes[0].lingua, lote = []; let tam = 0;
      for (let i = 0; i < pendentes.length && lote.length < 25;) {
        const p = pendentes[i];
        if (p.lingua !== lingua || (lote.length && tam + p.texto.length > 3500)) { i++; continue; }
        lote.push(p); tam += p.texto.length; pendentes.splice(i, 1);
      }
      try {
        const res = await traduzirLote(lote.map(p => p.texto.slice(0, 4500)), lingua);
        lote.forEach((p, i) => res[i] && res[i].trim() ? p.ok(res[i]) : p.erro(new Error('empty translation')));
      } catch (e) { lote.forEach(p => p.erro(e)); }
    }
  } finally { rodandoLote = false; }
}

async function traduzir(texto) {
  await carregado;   // garante que a lingua escolhida ja foi lida
  const lingua = idioma, base = norm(texto);
  if (!base) return null;
  const k = lingua + '|' + base;   // cada traducao fica guardada junto com a lingua
  if (cache.has(k)) return cache.get(k);
  if (emAndamento.has(k)) return emAndamento.get(k);
  const prot = proteger(texto);
  if (soTermos(prot.txt)) return texto;
  const p = pedirTraducao(prot.txt, lingua).then(t => {
    t = restaurar((t || '').trim(), prot.mapa).texto.trim();
    if (t) { cache.set(k, t); if (cache.size > 3000) cache.delete(cache.keys().next().value); agendarSalvar(); }
    return t || null;
  }).catch(e => { ultimoErro = String((e && e.message) || e); return null; }).finally(() => emAndamento.delete(k));
  emAndamento.set(k, p);
  return p;
}

chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
  if (msg.tipo === 'traduzir') { ultimoErro = ''; traduzir(msg.texto).then(t => responder({ traducao: t, erro: t ? '' : (ultimoErro || 'traducao vazia') })); return true; }
  return false;
});

// =====================================================================
// Resumo e verificacao com a API do Claude
// =====================================================================
const PADRAO = { apiKey: '', modeloResumo: 'claude-haiku-5-5', modeloCheck: 'claude-haiku-5-5' };
// quem estava no Haiku 4.5 (antigo padrao) passa para o Haiku 5.5, ~10x mais barato por token
chrome.storage.local.get({ modeloResumo: '', modeloCheck: '' }, c => {
  const novo = {};
  for (const k of ['modeloResumo', 'modeloCheck']) if (/^claude-haiku-4-5/.test(c[k])) novo[k] = 'claude-haiku-5-5';
  if (Object.keys(novo).length) chrome.storage.local.set(novo);
});
// Haiku 5.5 pensa antes de responder por padrao: "low" deixa o pensamento no minimo (menos tokens de saida).
// O pensamento conta no max_tokens, por isso os limites abaixo tem folga (so e cobrado o que for gerado).
// esforco baixo = responde mais rapido. Se a API recusar para algum modelo, esse modelo passa a ir sem
const semEsforco = new Set(), semPensar = new Set();
// Haiku 5.5 "pensa" alguns segundos mesmo no esforco baixo: desligado ele responde direto (a extensao ja entrega tudo pronto)
const extrasModelo = modelo => Object.assign({},
  /haiku-5|sonnet-5|opus-5/.test(modelo) && !semEsforco.has(modelo) ? { output_config: { effort: 'low' } } : {},
  /haiku-5/.test(modelo) && !semPensar.has(modelo) ? { thinking: { type: 'disabled' } } : {});
const cacheResumo = new Map(), cacheCheck = new Map(), emVoo = new Map();
// caches do Claude ficam salvos: se o service worker dormir ou voce reabrir o navegador, nao paga de novo
const ccCarregado = new Promise(ok => chrome.storage.local.get({ ccache: [] }, c => { try { (c.ccache || []).forEach(([t, k, v]) => (t === 'r' ? cacheResumo : cacheCheck).set(k, v)); } catch (e) {} ok(); }));
let ctimer = null;
function salvarCC() {
  if (ctimer) return;
  ctimer = setTimeout(() => { ctimer = null; try {
    const a = [...Array.from(cacheResumo.entries()).slice(-150).map(([k, v]) => ['r', k, v]), ...Array.from(cacheCheck.entries()).slice(-150).map(([k, v]) => ['c', k, v])];
    chrome.storage.local.set({ ccache: a });
  } catch (e) {} }, 1500);
}
// evita duas chamadas iguais ao mesmo tempo (duplo clique, balao reaberto)
function unico(k, fn) { if (emVoo.has(k)) return emVoo.get(k); const p = fn().finally(() => emVoo.delete(k)); emVoo.set(k, p); return p; }

function erroAmigavel(e) {
  const m = String((e && e.message) || e);
  if (m === 'SEM_CHAVE') return T('e_semChave');
  if (e && e.status === 401) return T('e_chaveInvalida');
  if (e && e.status === 429) return T('e_limite');
  if (e && e.status === 400 && /credit|balance/i.test(m)) return T('e_semCredito');
  if (e && e.status === 400 && /web.?search|tool/i.test(m)) return T('e_buscaWeb');
  return m.slice(0, 160);
}

// ---- medidor de gasto por funcao (estimado a partir do "usage" que a propria API devolve) ----
const PRECO = { haiku5: { i: 0.1, o: 0.5, cw: 0.125, cr: 0.01 }, haiku: { i: 1, o: 5, cw: 1.25, cr: 0.1 }, sonnet: { i: 2, o: 10, cw: 2.5, cr: 0.2 } }; // US$ por milhao de tokens (precos oficiais de out/2026)
let filaUso = Promise.resolve();
function registrarUso(func, modelo, u, ms) {
  if (!u) return;
  const p = /haiku-5/i.test(modelo) ? PRECO.haiku5 : /haiku/i.test(modelo) ? PRECO.haiku : PRECO.sonnet;
  const i = u.input_tokens || 0, o = u.output_tokens || 0, cw = u.cache_creation_input_tokens || 0, cr = u.cache_read_input_tokens || 0;
  const buscas = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  const custo = (i * p.i + o * p.o + cw * p.cw + cr * p.cr) / 1e6 + buscas * 0.01;
  const dia = new Date().toISOString().slice(0, 10);
  filaUso = filaUso.then(() => chrome.storage.local.get({ uso: {}, usolog: [] })).then(({ uso, usolog }) => {
    const d = uso[dia] = uso[dia] || {}, f = d[func] = d[func] || { n: 0, i: 0, o: 0, b: 0, c: 0 };
    f.n += 1; f.i += i + cw + cr; f.o += o; f.b += buscas; f.c += custo;
    for (const k of Object.keys(uso).sort().slice(0, -90)) delete uso[k];
    usolog.push({ t: Date.now(), f: func, m: /haiku/i.test(modelo) ? 'haiku' : 'sonnet', i: i + cw + cr, o, b: buscas, c: custo, ms: ms || 0 });
    return chrome.storage.local.set({ uso, usolog: usolog.slice(-200) });
  }).catch(() => {});
}
// le a resposta em streaming (SSE) e remonta a mensagem igual a da chamada normal: { content, stop_reason, usage }
// blocos das ferramentas do servidor (server_tool_use, web_search_tool_result, web_fetch_tool_result) chegam inteiros no inicio do bloco;
// a entrada da busca chega aos pedacos (input_json_delta). aoPedaco recebe cada pedaco de texto
async function lerSSE(r, aoPedaco) {
  const leitor = r.body.getReader(), dec = new TextDecoder(), j = { content: [], stop_reason: null, usage: {} }, json = {};
  let buf = '';
  for (;;) {
    const { done, value } = await leitor.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const linha = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!linha.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(linha.slice(5)); } catch (e) { continue; }
      // erro no meio do stream (ex.: overloaded): vira erro de rede, o claude() tenta de novo uma vez
      if (ev.type === 'error') throw new Error((ev.error && ev.error.message) || 'stream error');
      if (ev.type === 'message_start' && ev.message) Object.assign(j.usage, ev.message.usage || {});
      if (ev.type === 'message_delta') { if (ev.usage) Object.assign(j.usage, ev.usage); if (ev.delta && ev.delta.stop_reason) j.stop_reason = ev.delta.stop_reason; }
      if (ev.type === 'content_block_start') { j.content[ev.index] = Object.assign({}, ev.content_block); if (ev.content_block.type === 'server_tool_use' || ev.content_block.type === 'tool_use') json[ev.index] = ''; }
      const b = j.content[ev.index], d = ev.delta || {};
      if (ev.type === 'content_block_delta' && b) {
        if (d.type === 'text_delta') { b.text = (b.text || '') + d.text; if (aoPedaco) aoPedaco(d.text); }
        else if (d.type === 'input_json_delta') json[ev.index] += d.partial_json || '';
        else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
        else if (d.type === 'signature_delta') b.signature = d.signature;
        else if (d.type === 'citations_delta') (b.citations = b.citations || []).push(d.citation);
      }
      if (ev.type === 'content_block_stop' && b) {
        if (ev.index in json) try { b.input = JSON.parse(json[ev.index] || '{}'); } catch (e) { b.input = {}; }
        if (b.type === 'text' && !b.citations) delete b.citations;
      }
    }
  }
  j.content = j.content.filter(Boolean);
  return j;
}
// aoTexto (opcional): pede em streaming e recebe o texto acumulado (todas as rodadas) a cada pedaco
async function claude({ modelo, system, user, messages: msgs, tools, maxTokens, func, imagens, limite = 75000, aoTexto }) {
  const { apiKey } = await chrome.storage.local.get({ apiKey: '' });
  if (!apiKey) throw new Error('SEM_CHAVE');
  // imagens do tweet vao junto (o Claude baixa pelo endereco), antes do texto
  const conteudo = imagens && imagens.length ? imagens.map(url => ({ type: 'image', source: { type: 'url', url } })).concat([{ type: 'text', text: user }]) : user;
  let messages = msgs || [{ role: 'user', content: conteudo }];
  // instrucoes longas (com a base de conhecimento) ficam em cache: nas chamadas seguintes custam ~10% do preco
  await carregado; system = naLingua(system);   // resposta na lingua escolhida nas configuracoes
  if (typeof system === 'string' && system.length > 2500) system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  const inicio = Date.now(), textos = [];   // texto de todas as rodadas (a resposta pode comecar numa e terminar na outra)
  const textoDe = j => (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  // tempo acabou: o que ja chegou (rodadas anteriores) pode ter a resposta inteira
  let parcial = '';   // texto da rodada em andamento (streaming): conta para a sobra se o tempo acabar no meio
  const sobra = () => { const t = (textos.join('') + parcial).trim(); if (/"veredito"/.test(t)) return t; throw new Error(T('e_demorou')); };
  let tentou = false;
  for (let i = 0; i < 4; i++) {
    // limite total de 75 s (somando as rodadas de busca): nada fica "buscando" para sempre
    const resta = limite - (Date.now() - inicio);
    if (resta < 1500) return sobra();
    const t0 = Date.now(), ctrl = new AbortController(), tempo = setTimeout(() => ctrl.abort(), resta);
    let r, j; parcial = '';
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: {
          'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(Object.assign({ model: modelo, max_tokens: maxTokens, system, messages }, aoTexto ? { stream: true } : {}, tools && tools.length ? { tools } : {}, extrasModelo(modelo)))
      });
      j = aoTexto && r.ok && /event-stream/.test(r.headers.get('content-type') || '') ? await lerSSE(r, d => { parcial += d; aoTexto(textos.join('') + parcial); }) : await r.json().catch(() => ({}));
    } catch (e) {
      clearTimeout(tempo);
      if (e.name === 'AbortError') return sobra();
      // rede caiu: tenta de novo uma vez
      if (!tentou && limite - (Date.now() - inicio) > 4000) { tentou = true; i--; await new Promise(ok => setTimeout(ok, 600)); continue; }
      throw e;
    } finally { clearTimeout(tempo); }
    if (r.status === 400 && /effort|output_config/i.test(JSON.stringify(j)) && !semEsforco.has(modelo)) { semEsforco.add(modelo); i--; continue; }
    if (r.status === 400 && /thinking/i.test(JSON.stringify(j)) && !semPensar.has(modelo)) { semPensar.add(modelo); i--; continue; }
    // API sobrecarregada (529) ou erro do servidor: tenta de novo uma vez
    if ((r.status === 529 || r.status >= 500) && !tentou && limite - (Date.now() - inicio) > 4000) {
      console.log('[Axiom Helper] ' + (func || 'claude') + ': status ' + r.status + ', trying again');
      tentou = true; i--; await new Promise(ok => setTimeout(ok, 600)); continue;
    }
    console.log('[Axiom Helper] ' + (func || 'claude') + ': round ' + (i + 1) + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s, status ' + r.status + (j.stop_reason ? ', ' + j.stop_reason : ''));
    if (!r.ok) { const e = new Error((j.error && j.error.message) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    registrarUso(func || 'outros', modelo, j.usage, Date.now() - t0);
    if (j.stop_reason === 'refusal') throw new Error(T('e_recusou'));
    textos.push(textoDe(j));
    if (j.stop_reason === 'pause_turn') { messages = messages.concat([{ role: 'assistant', content: j.content }]); continue; }
    if (j.stop_reason === 'max_tokens') console.log('[Axiom Helper] ' + (func || 'claude') + ': response cut off by the size limit');
    return textos.join('').trim();
  }
  throw new Error(T('e_pesquisaDemorou'));
}

const SISTEMA_RESUMO =
  'You summarize tweets for a memecoin trader. Write in Brazilian Portuguese, at most 2 short simple sentences (max 45 words). ' +
  'Context: on Axiom the tweet is almost always from someone else (a celebrity, a news outlet, a random person or a tech/launchpad account) and someone launched a coin on top of it. ' +
  'You get the main "Tweet" and, when present, the "Tweet citado" (the one it quotes or replies to). ' +
  'With a quoted tweet: first say in a few words what the quoted one says, then what the main tweet does with it (agrees, mocks, replies, or parodies it by swapping words) and its point or joke. ' +
  'Main tweet only: say what it is about and the main point. ' +
  'If it launches or promotes a coin, say its theme or joke. Uncommon slang or acronym: explain in 2-3 words in parentheses. Write like explaining to a friend, lead with the main idea. ' +
  'No opinion, no emojis, no copying whole sentences. Keep names, tickers and numbers exact. Reply with the summary only.';

// ---- Resumo local (sem API): escolhe as frases mais importantes e traduz ----
const PARADAS = new Set(('the a an and or but of to in on for with is are was were be been it this that these those at by from as we you i they he she our your their its will can just not no so if then than also have has had do does about into more most very new all out up what who when how why which there here de da do das dos e o a os as um uma em para por com que se na no nas nos ao aos mais muito como mas foi sao ser tem ter').split(' '));
function resumoLocal(texto) {
  // "loucura!Soulja": frase colada na anterior (quebra de linha perdida) vira frase separada
  const limpo = String(texto).replace(/https?:\/\/\S+/g, ' ').replace(/([.!?])(?=[A-ZÀ-Ú])/g, '$1\n').replace(/[ \t]+/g, ' ');
  let fr = limpo.split(/(?<=[.!?])\s+|\n+/).map(x => x.trim()).filter(x => x.split(/\s+/).length >= 4);
  if (!fr.length) fr = [limpo.trim()];
  const freq = {};
  for (const f of fr) for (const w of f.toLowerCase().match(/[a-z0-9$@#áéíóúãõâêôç]+/g) || []) if (!PARADAS.has(w) && w.length > 2) freq[w] = (freq[w] || 0) + 1;
  const pontos = fr.map((f, i) => {
    const ws = f.toLowerCase().match(/[a-z0-9$@#áéíóúãõâêôç]+/g) || [];
    let p = 0; for (const w of ws) p += freq[w] || 0;
    p = p / Math.sqrt(ws.length || 1);
    if (/\d/.test(f)) p *= 1.25;
    if (/\$[a-z]{2,}/i.test(f)) p *= 1.2;
    if (i === 0) p *= 1.5;
    if (ws.length > 40) p *= 0.6;
    return { f, i, p };
  });
  const top = pontos.sort((a, b) => b.p - a.p).slice(0, 2).sort((a, b) => a.i - b.i).map(x => x.f);
  let out = top.join(' ');
  const pal = out.split(/\s+/);
  if (pal.length > 38) out = pal.slice(0, 38).join(' ') + '...';
  return out;
}

// ---- leitura dos links do tweet ----
// O balao do Axiom mostra o tweet cortado (ex.: so "x.com/i/article/2107..."). O texto completo, o artigo do X e o tweet citado
// vem do fxtwitter (gratis, sem login). Links de fora do X sao abertos pelo proprio Claude com a ferramenta web_fetch.
const cacheTweet = new Map();
function textoDoArtigo(a) {
  const blocos = a.content && Array.isArray(a.content.blocks) ? a.content.blocks.map(b => b && b.text).filter(Boolean).join('\n') : '';
  return String(blocos || a.preview_text || a.text || '').slice(0, 6000);
}
// imagens do tweet (fotos e capas de video/GIF): no maximo 3, na versao menor do X (gasta menos tokens)
function imagensUnicas(...listas) {
  const menor = u => /pbs\.twimg\.com\/media\//.test(u) ? u.split('?')[0] + '?name=small' : u;
  return [...new Set(listas.flat().filter(u => typeof u === 'string' && /^https:\/\/pbs\.twimg\.com\//.test(u)).map(menor))].slice(0, 3);
}
const SEM_TWEET = { texto: '', imagens: [] };
// le o tweet pelo fxtwitter: texto completo, autor (alcance da conta), artigo, tweet citado e imagens
// guarda a promessa por id do tweet: a pre-busca (balao aberto) e o clique usam a mesma leitura, sem buscar duas vezes
function lerTweet(status) {   // status = "usuario/id"
  if (!/^[A-Za-z0-9_]{1,15}\/\d+$/.test(status || '')) return Promise.resolve(SEM_TWEET);
  const id = status.split('/')[1];
  if (!cacheTweet.has(id)) {
    const p = buscarTweet(status);
    cacheTweet.set(id, p);
    // falha (lento, fora do ar) nao fica guardada: a proxima analise tenta de novo
    p.then(r => { if (!r.texto && !r.apagado && cacheTweet.get(id) === p) cacheTweet.delete(id); });
    if (cacheTweet.size > 300) cacheTweet.delete(cacheTweet.keys().next().value);
  }
  return cacheTweet.get(id);
}
// pede um JSON com limite de tempo (nada do fxtwitter pode travar a analise)
async function jsonComLimite(url, ms) {
  const ctrl = new AbortController(), tempo = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { signal: ctrl.signal }); return { status: r.status, j: r.ok ? await r.json().catch(() => null) : null }; }
  finally { clearTimeout(tempo); }
}
async function buscarTweet(status) {
  const [usuario, id] = status.split('/');
  try {
    // v2: tem a nota da comunidade e o id do tweet respondido. Se falhar (fora do ar), a v1 antiga
    let r = await jsonComLimite('https://api.fxtwitter.com/2/status/' + id, 6000), t = r.j && r.j.status;
    // 404 ou 401: o tweet nao existe mais no X (apagado, ou a conta ficou privada/suspensa)
    if (r.status === 404 || r.status === 401) return { texto: '', imagens: [], apagado: true };
    if (!t) {
      r = await jsonComLimite('https://api.fxtwitter.com/' + usuario + '/status/' + id, 5000); t = r.j && r.j.tweet;
      if (r.status === 404) return { texto: '', imagens: [], apagado: true };
    }
    if (!t) return SEM_TWEET;
    const partes = [], imagens = [];
    const a = t.author || {};
    if (a.screen_name) partes.push('Autor do tweet: ' + (a.name || a.screen_name) + ' (@' + a.screen_name + ')' +
      (a.followers != null ? ', ' + a.followers + ' seguidores' : '') + (a.description ? '. Bio: ' + String(a.description).slice(0, 200) : ''));
    if (t.text) partes.push('Texto completo do tweet:\n' + t.text);
    if (t.article) partes.push('Artigo do X' + (t.article.title ? ' "' + t.article.title + '"' : '') + ':\n' + textoDoArtigo(t.article));
    if (t.quote && t.quote.text) partes.push('Tweet citado (@' + ((t.quote.author && t.quote.author.screen_name) || '?') + '):\n' + t.quote.text);
    else if (t.quote && t.quote.reason) partes.push('O tweet citado nao esta mais disponivel no X (' + t.quote.reason + ').');
    const nota = t.community_note && t.community_note.text;
    if (nota) partes.push('Nota da comunidade do X (Community Notes) neste tweet:\n' + String(nota).slice(0, 1200));
    // reply: busca o tweet respondido (quem disse o que)
    const pai = t.replying_to && typeof t.replying_to === 'object' ? t.replying_to.status : t.replying_to_status;
    if (pai && /^\d+$/.test(String(pai))) {
      try {
        const rp = await jsonComLimite('https://api.fxtwitter.com/2/status/' + pai, 3000), tp = rp.j && rp.j.status;
        if (tp && tp.text) partes.push('Tweet respondido (@' + ((tp.author && tp.author.screen_name) || '?') + '):\n' + String(tp.text).slice(0, 1500));
      } catch (e) {}
    }
    const midias = tw => {
      const m = (tw && tw.media) || {};
      for (const x of [].concat(m.photos || [], m.videos || [], m.all || [])) imagens.push(x.thumbnail_url || (x.type !== 'video' && x.type !== 'gif' ? x.url : ''));
    };
    midias(t); midias(t.quote);
    if (t.article && t.article.cover_media && t.article.cover_media.media_info) imagens.push(t.article.cover_media.media_info.original_img_url);
    return { texto: partes.join('\n\n').slice(0, 9000), imagens: imagensUnicas(imagens) };
  } catch (e) { console.log('[Axiom Helper] fxtwitter failed:', e.name === 'AbortError' ? 'took too long' : e.message); return SEM_TWEET; }
}

// ---- pesquisa rapida e gratis, em paralelo, na hora do clique (a IA recebe pronta e quase nao precisa buscar) ----
// posts que citam o tweet, posts no X sobre o assunto (fxtwitter) e manchetes das noticias (Google News)
// palavras do assunto: tira links, @, emojis e palavras vazias; fica com as 8 primeiras que dizem algo
function consultaDe(texto, citado) {
  const limpo = t => String(t || '').replace(/^Escrito por[^\n]*\n/i, '').replace(/^Repostado \(retweet[^\n]*\n*/i, '').replace(/https?:\/\/\S+/g, ' ').replace(/[@#$][\w]+/g, ' ');
  const base = limpo(texto).split(/\s+/).length >= 6 ? limpo(texto) : limpo(texto) + ' ' + limpo(citado);
  const vistas = new Set(), pal = [];
  for (const w of base.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || []) {
    const k = w.toLowerCase().replace(/[.'’-]+$/, '');
    if (k.length < 3 || PARADAS.has(k) || vistas.has(k)) continue;
    vistas.add(k); pal.push(w.replace(/[.'’-]+$/, ''));
    if (pal.length >= 8) break;
  }
  return pal.length >= 2 ? pal.join(' ') : '';
}
const linhaPost = p => '- @' + ((p.author && p.author.screen_name) || '?') + (p.created_at ? ', ' + String(p.created_at).replace(/ \+0000/, '') : '') +
  (p.likes != null ? ', ' + p.likes + ' likes' : '') + ': ' + String(p.text || '').replace(/\s+/g, ' ').slice(0, 220);
const desfazerXml = t => String(t || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
async function noticiasGoogle(q) {
  const ctrl = new AbortController(), tempo = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch('https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:7d') + '&hl=en-US&gl=US&ceid=US:en', { signal: ctrl.signal });
    if (!r.ok) return [];
    const xml = await r.text();
    const itens = [];
    const saida = (xml.match(/<item>[\s\S]*?<\/item>/g) || []).slice(0, 6).map(it => {
      const pega = n => desfazerXml((it.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>')) || [])[1]);
      itens.push({ titulo: pega('title').slice(0, 140), data: pega('pubDate').replace(/ \d\d:\d\d:\d\d GMT/, ''), fonte: pega('source').slice(0, 60), fonteUrl: ((it.match(/<source[^>]+url="([^"]+)"/) || [])[1] || '') });
      return '- ' + pega('title').slice(0, 200) + (pega('pubDate') ? ' (' + pega('pubDate').replace(/ \d\d:\d\d:\d\d GMT/, '') + ')' : '');
    });
    saida.itens = itens;   // para o historico: titulo, data e site de cada manchete
    return saida;
  } catch (e) { return []; } finally { clearTimeout(tempo); }
}
// Bing Noticias (RSS, sem chave): titulo, resumo, veiculo e data. Mais completo que o Google News, que so da o titulo
async function noticiasBing(q) {
  const ctrl = new AbortController(), tempo = setTimeout(() => ctrl.abort(), 2000);
  try {
    const r = await fetch('https://www.bing.com/news/search?format=rss&setlang=en-US&cc=US&qft=sortbydate%3d%221%22&q=' + encodeURIComponent(q), { signal: ctrl.signal });
    if (!r.ok) return [];
    const xml = await r.text();
    return (xml.match(/<item>[\s\S]*?<\/item>/g) || []).slice(0, 6).map(it => {
      const pega = n => desfazerXml((it.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>')) || [])[1]);
      let link = pega('link'); try { link = new URL(link).searchParams.get('url') || link; } catch (e) {}
      return { titulo: pega('title'), resumo: pega('description').replace(/<[^>]+>/g, '').slice(0, 260), fonte: pega('News:Source'), data: pega('pubDate').replace(/ \d\d:\d\d:\d\d GMT/, ''), link };
    }).filter(x => x.titulo);
  } catch (e) { return []; } finally { clearTimeout(tempo); }
}
// DuckDuckGo (pagina HTML simples, sem chave): resultados da web da ultima semana. 1 pedido por clique (pedidos seguidos sao bloqueados)
async function buscaDDG(q) {
  const ctrl = new AbortController(), tempo = setTimeout(() => ctrl.abort(), 2000);
  try {
    const r = await fetch('https://html.duckduckgo.com/html/', { method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'kl=us-en&df=w&q=' + encodeURIComponent(q) });
    if (r.status !== 200) return [];   // 202 = bloqueio temporario
    const h = await r.text(), out = [];
    const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    for (let m; (m = re.exec(h)) && out.length < 5;) {
      let u = m[1].replace(/&amp;/g, '&'); const g = u.match(/[?&]uddg=([^&]+)/); if (g) u = decodeURIComponent(g[1]);
      if (/duckduckgo\.com\/y\.js/.test(u)) continue;   // anuncio
      out.push({ link: u, titulo: desfazerXml(m[2].replace(/<[^>]+>/g, '')), resumo: desfazerXml(m[3].replace(/<[^>]+>/g, '')).slice(0, 260) });
    }
    return out;
  } catch (e) { return []; } finally { clearTimeout(tempo); }
}
// le uma pagina (noticia, site): texto do artigo (JSON-LD), senao a descricao e os paragrafos. So o comeco (300 KB).
// Sites que nao deixam a extensao ler devolvem vazio na hora
// so tenta quando a extensao tem permissao para o site: sem ela o Chrome bloqueia (CORS) e anota um erro na pagina da extensao
async function podeLer(url) {
  try { return await chrome.permissions.contains({ origins: [new URL(url).origin + '/*'] }); } catch (e) { return false; }
}
async function lerPagina(url, ms) {
  if (!(await podeLer(url))) return '';
  const ctrl = new AbortController(), tempo = setTimeout(() => ctrl.abort(), ms || 1800);
  try {
    const r = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!r.ok || !/html|text/i.test(r.headers.get('content-type') || '')) return '';
    const leitor = r.body.getReader(), dec = new TextDecoder(); let h = '';
    while (h.length < 300000) { const { done, value } = await leitor.read(); if (done) break; h += dec.decode(value, { stream: true }); }
    try { leitor.cancel(); } catch (e) {}
    const limpa = t => desfazerXml(String(t || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const meta = n => limpa((h.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + n + '["\'][^>]+content=["\']([^"\']*)', 'i')) || [])[1]);
    const titulo = meta('og:title') || limpa((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    const data = meta('article:published_time') || ((h.match(/"datePublished"\s*:\s*"([^"]+)"/) || [])[1] || '');
    let corpo = '';
    for (const s of h.match(/<script[^>]+ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []) { const b = (s.match(/"articleBody"\s*:\s*"((?:\\.|[^"\\])*)"/) || [])[1]; if (b) { try { corpo = JSON.parse('"' + b + '"'); } catch (e) {} break; } }
    if (!corpo) corpo = (h.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || []).map(limpa).filter(p => p.length > 60).join('\n');
    const desc = meta('og:description') || meta('description');
    return (corpo || desc) ? (titulo ? 'Titulo: ' + titulo + '\n' : '') + (data ? 'Data: ' + data.slice(0, 10) + '\n' : '') + (corpo || desc).slice(0, 1800) : '';
  } catch (e) { return ''; } finally { clearTimeout(tempo); }
}
// artigo do X (x.com/i/article/ID): o fxtwitter so da o texto pela lista de artigos do autor
async function artigoDoX(aid, handles) {
  for (const h of handles.slice(0, 2)) {
    try {
      const r = await jsonComLimite('https://api.fxtwitter.com/2/profile/' + encodeURIComponent(h) + '/articles?count=20', 3500);
      const s = ((r.j && r.j.results) || []).find(x => x && x.article && String(x.article.id) === aid);
      if (s) return '\n\n<artigo_do_x autor="@' + h + '">\n' + (s.article.title ? s.article.title + '\n\n' : '') + textoDoArtigo(s.article) + '\n</artigo_do_x>';
    } catch (e) {}
  }
  return '';
}
const cachePesquisa = new Map();
function pesquisaRapida(status, texto, citado, autor, links) {
  const id = (String(status || '').match(/\/(\d+)$/) || [])[1] || '', q = consultaDe(texto, citado);
  const k = id + '|' + q;
  if (!id && !q) return Promise.resolve('');
  const salvo = cachePesquisa.get(k);
  if (salvo && Date.now() - salvo.t < 10 * 60 * 1000) return salvo.p;
  const lista = (url, filtro) => jsonComLimite(url, 3000).then(r => ((r.j && r.j.results) || []).filter(filtro)).catch(() => []);
  // tweet que e so um link de artigo do X: busca o texto do artigo (se o fxtwitter nao trouxe com o tweet)
  const tudo = [texto, citado].concat(links || []).join(' ');
  const aid = (tudo.match(/x\.com\/i\/article\/\d+/g) || []).map(u => u.split('/').pop()).sort((x, y) => y.length - x.length)[0];
  const handles = [...new Set([autor, (String(texto).match(/^RT @(\w{1,15})/) || [])[1], ...(String(citado || '').match(/@(\w{1,15})/g) || []).map(h => h.slice(1))].filter(Boolean))];
  // as duas buscas comecam juntas; se o fxtwitter ja trouxe o artigo no tweet, o da lista e descartado
  const artigo = aid && handles.length ? Promise.all([lerTweet(status), artigoDoX(aid, handles)]).then(([l, a]) => /Artigo do X/.test(l.texto) ? '' : a).catch(() => '') : Promise.resolve('');
  const rastro = { q, x: [], posts: [], google: [], bing: [], web: [], artigo: null };   // o que a extensao olhou (para o historico da lupa)
  const p = Promise.all([artigo,
    id ? lista('https://api.fxtwitter.com/2/status/' + id + '/quotes?count=10', x => x && x.text) : [],
    q ? lista('https://api.fxtwitter.com/2/search?q=' + encodeURIComponent(q) + '&feed=top&count=10', x => x && x.text && x.id !== id) : [],
    q ? noticiasGoogle(q) : [],
    q ? noticiasBing(q) : [],
    q ? buscaDDG(q) : []
  ]).then(async ([art, citacoes, busca, noticias, bing, ddg]) => {
    // abre a primeira noticia achada (Bing, senao DuckDuckGo): a IA le o texto em vez de so o titulo
    const primeira = (bing[0] || ddg[0] || {}).link;
    const corpo = primeira && !SEM_CONTEUDO.test(primeira) ? await lerPagina(primeira, 1500) : '';
    const xlink = x => ({ u: 'https://x.com/' + ((x.author && x.author.screen_name) || 'i') + '/status/' + x.id, a: (x.author && x.author.screen_name) || '?', t: String(x.text || '').replace(/\s+/g, ' ').slice(0, 110) });
    rastro.x = citacoes.slice(0, 5).map(xlink); rastro.posts = busca.slice(0, 6).map(xlink); rastro.google = (noticias.itens || []).slice(0, 6);
    rastro.bing = bing.slice(0, 6).map(n => ({ titulo: n.titulo.slice(0, 140), fonte: n.fonte, data: n.data, link: n.link })); rastro.web = ddg.slice(0, 5).map(n => ({ titulo: n.titulo.slice(0, 140), link: n.link }));
    if (primeira) rastro.artigo = { u: primeira, ok: !!corpo }; if (art) rastro.xartigo = true;
    const por = (a, b) => (b.likes || 0) - (a.likes || 0);
    const partes = [];
    if (citacoes.length) partes.push('Posts que citam este tweet (o que os outros dizem dele):\n' + citacoes.sort(por).slice(0, 5).map(linhaPost).join('\n'));
    if (busca.length) partes.push('Posts no X sobre o assunto (busca "' + q + '"; o mais antigo pode ser o original):\n' + busca.slice(0, 6).map(linhaPost).join('\n'));
    if (bing.length) partes.push('Noticias no Bing, mais novas primeiro (busca "' + q + '"):\n' + bing.map(n => '- ' + n.titulo + (n.fonte ? ' (' + n.fonte + (n.data ? ', ' + n.data : '') + ')' : '') + (n.resumo ? ': ' + n.resumo : '') + ' [' + n.link + ']').join('\n'));
    if (noticias.length) partes.push('Manchetes no Google News, ultimos 7 dias (busca "' + q + '"):\n' + noticias.join('\n'));
    if (ddg.length) partes.push('Resultados da web, ultima semana (DuckDuckGo, busca "' + q + '"):\n' + ddg.map(n => '- ' + n.titulo + ': ' + n.resumo + ' [' + n.link + ']').join('\n'));
    if (corpo) partes.push('Texto da primeira noticia (' + primeira + '):\n' + corpo);
    console.log('[Axiom Helper] quick research: ' + citacoes.length + ' quote(s), ' + busca.length + ' X post(s), ' + noticias.length + ' Google + ' + bing.length + ' Bing headline(s), ' + ddg.length + ' web result(s)' + (corpo ? ', 1 article read' : ''));
    return art + (partes.length ? '\n\n<pesquisa_rapida>\n' + partes.join('\n\n') + '\n</pesquisa_rapida>' : '');
  }).catch(() => '');
  p.rastro = rastro;
  cachePesquisa.set(k, { p, t: Date.now() });
  if (cachePesquisa.size > 100) cachePesquisa.delete(cachePesquisa.keys().next().value);
  return p;
}
// paginas de negociacao e graficos: pesadas (montadas por JavaScript) e nao dizem nada sobre a noticia, entao nao vale abrir
const SEM_CONTEUDO = /^https?:\/\/([\w-]+\.)*(x\.com|twitter\.com|pump\.fun|dexscreener\.com|birdeye\.so|axiom\.trade|gmgn\.ai|photon-sol\.tinyastro\.io|jup\.ag|raydium\.io|solscan\.io|solana\.fm|bullx\.io|t\.me|discord\.(gg|com))\//i;
// links de fora do X: os do balao + os que estao escritos no texto do tweet e no conteudo lido (as fontes que o proprio tweet cita)
function linksDeFora(links, ...textos) {
  const todos = (Array.isArray(links) ? links : []).concat(...textos.map(t => String(t || '').match(/https?:\/\/[^\s"'<>)\]]+/g) || []));
  let lista = Array.from(new Set(todos.map(l => l.replace(/[.,;:!?…]+$/, '')))).filter(l => /^https?:\/\//.test(l) && !/…$/.test(l) && !SEM_CONTEUDO.test(l + '/'));
  // link encurtado (t.co) so se nao houver o endereco real: o fxtwitter ja traz os links expandidos
  if (lista.some(l => !/^https?:\/\/t\.co\//.test(l))) lista = lista.filter(l => !/^https?:\/\/t\.co\//.test(l));
  return lista.slice(0, 4);
}
// GitHub e Reddit: a extensao le pela API publica deles (rapido, sem login). A IA nao consegue abrir o Reddit
const dataCurta = t => t ? new Date(t).toISOString().slice(0, 10) : '?';
async function textoComLimite(url, ms, headers) {
  const ctrl = new AbortController(), tempo = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { signal: ctrl.signal, headers }); return r.ok ? await r.text() : ''; }
  finally { clearTimeout(tempo); }
}
async function lerSitio(url) {
  if (!sitioLe(url)) return lerPagina(url, 2000);   // site comum: tenta ler a pagina (so funciona nos sites que deixam)
  try {
    let m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)(?:\/([\w.-]+))?\/?(?:[?#].*)?$/i);
    if (m && m[2]) {
      const [o, r] = [m[1], m[2].replace(/\.git$/, '')];
      const [repo, leia] = await Promise.all([jsonComLimite('https://api.github.com/repos/' + o + '/' + r, 3000),
        textoComLimite('https://api.github.com/repos/' + o + '/' + r + '/readme', 3000, { accept: 'application/vnd.github.raw' }).catch(() => '')]);
      const j = repo.j; if (!j) return repo.status === 404 ? 'Repositorio GitHub ' + o + '/' + r + ': nao existe ou e privado (404).' : '';
      return 'Repositorio GitHub ' + j.full_name + (j.fork ? ' (fork)' : '') + ': ' + (j.description || 'sem descricao') + '\n' +
        'Criado ' + dataCurta(j.created_at) + ', ultimo push ' + dataCurta(j.pushed_at) + ', ' + j.stargazers_count + ' estrelas, ' + j.forks_count + ' forks, linguagem ' + (j.language || '?') + '.' +
        (leia ? '\nREADME (comeco):\n' + leia.replace(/<[^>]+>/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500) : '');
    }
    if (m && /^[\w-]+$/.test(m[1])) {
      const u = (await jsonComLimite('https://api.github.com/users/' + m[1], 3000)).j;
      return u ? 'Perfil GitHub ' + u.login + ' (' + (u.name || '') + '): conta criada ' + dataCurta(u.created_at) + ', ' + u.public_repos + ' repositorios publicos, ' + u.followers + ' seguidores.' + (u.bio ? ' Bio: ' + u.bio : '') : '';
    }
    m = url.match(/^https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/\w+\/comments\/(\w+)/i);
    if (m) {
      const j = (await jsonComLimite('https://www.reddit.com/comments/' + m[1] + '.json?limit=5&sort=top&raw_json=1', 3500)).j;
      const p = j && j[0] && j[0].data.children[0] && j[0].data.children[0].data; if (!p) return '';
      const coms = ((j[1] && j[1].data.children) || []).map(c => c.data).filter(c => c && c.body && !c.stickied).slice(0, 4);
      return 'Post no Reddit r/' + p.subreddit + ' por u/' + p.author + ', ' + dataCurta(p.created_utc * 1000) + ', ' + p.score + ' pontos, ' + p.num_comments + ' comentarios' +
        (p.removed_by_category ? ', REMOVIDO (' + p.removed_by_category + ')' : '') + '.\nTitulo: ' + p.title +
        (p.selftext ? '\n' + p.selftext.slice(0, 1500) : '') + (p.url && !/reddit\.com/.test(p.url) ? '\nLink do post: ' + p.url : '') +
        (coms.length ? '\nComentarios mais votados:\n' + coms.map(c => '- u/' + c.author + ' (' + c.score + '): ' + c.body.replace(/\s+/g, ' ').slice(0, 200)).join('\n') : '');
    }
    // TikTok: o tikwm (gratis, sem chave) traz texto, autor, data e numeros; o oEmbed oficial so traz o texto e o autor
    if (/^https?:\/\/([\w-]+\.)?tiktok\.com\//i.test(url)) {
      const n = v => v == null ? '?' : Number(v).toLocaleString('pt-BR');
      const perfil = url.match(/tiktok\.com\/@([\w.-]+)\/?(?:[?#].*)?$/i);
      if (perfil) {
        const j = (await jsonComLimite('https://www.tikwm.com/api/user/info?unique_id=' + encodeURIComponent(perfil[1]), 3500)).j, d = j && j.code === 0 && j.data;
        return d && d.user ? 'Perfil do TikTok @' + d.user.uniqueId + ' (' + (d.user.nickname || '') + (d.user.verified ? ', verificado' : '') + '): ' + n(d.stats && d.stats.followerCount) + ' seguidores, ' +
          n(d.stats && d.stats.heartCount) + ' curtidas no total, ' + n(d.stats && d.stats.videoCount) + ' videos.' + (d.user.signature ? ' Bio: ' + d.user.signature.slice(0, 300) : '') : '';
      }
      const j = (await jsonComLimite('https://www.tikwm.com/api/?url=' + encodeURIComponent(url), 3500)).j, d = j && j.code === 0 && j.data;
      if (d && d.id) return 'Video do TikTok de @' + ((d.author && d.author.unique_id) || '?') + ', postado ' + (d.create_time ? dataCurta(d.create_time * 1000) : '?') + ': ' +
        n(d.play_count) + ' views, ' + n(d.digg_count) + ' curtidas, ' + n(d.comment_count) + ' comentarios, ' + n(d.share_count) + ' compartilhamentos.\nTexto: ' + String(d.title || '').slice(0, 800);
      const o = (await jsonComLimite('https://www.tiktok.com/oembed?url=' + encodeURIComponent(url), 3000)).j;
      return o && o.title != null ? 'Video do TikTok de @' + (o.author_unique_id || o.author_name || '?') + ' (sem numeros de curtidas).\nTexto: ' + String(o.title).slice(0, 800) : '';
    }
  } catch (e) {}
  return '';
}
const cacheSitio = new Map();   // 10 min: a etapa rapida e a checagem usam a mesma leitura
function lerSitioCache(url) {
  const c = cacheSitio.get(url); if (c && Date.now() - c.t < 600000) return c.p;
  const p = lerSitio(url); cacheSitio.set(url, { p, t: Date.now() });
  p.then(t => { if (!t) cacheSitio.set(url, { p, t: Date.now() - 480000 }); });   // falha vale 2 min: nao gasta o limite por hora a cada clique
  if (cacheSitio.size > 100) cacheSitio.delete(cacheSitio.keys().next().value);
  return p;
}
const sitioLe = url => /^https?:\/\/(?:[\w-]+\.)?(github\.com|reddit\.com|tiktok\.com)\//i.test(url);
// bloco extra para o pedido: conteudo lido pelo fxtwitter + links externos que o Claude deve abrir primeiro
async function contextoLinks(status, links, texto, imagensDoBalao, espera) {
  // espera: limite (ms) para o fxtwitter. A etapa rapida nao fica parada nele: o Axiom ja deu o texto, o citado e o autor
  const leitura = lerTweet(status);
  // posts do X colados como link no tweet (nao sao citacao): le pelo fxtwitter tambem, no maximo 2
  const proprio = (String(status || '').match(/\/(\d+)$/) || [])[1];
  const ligados = [...new Set((String([].concat(links || [], texto || '').join(' ')).match(/(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d{15,20}/gi) || [])
    .map(u => u.replace(/^.*?\.com\//i, '').replace('/status/', '/')))].filter(s => s.split('/')[1] !== proprio).slice(0, 2);
  const leituraLigados = Promise.all(ligados.map(s => lerTweet(s).then(l => l.texto ? '\n\n<post_do_link url="x.com/' + s.replace('/', '/status/') + '">\n' + l.texto + '\n</post_do_link>' : (l.apagado ? '\n\n<post_do_link url="x.com/' + s.replace('/', '/status/') + '">apagado ou indisponivel no X</post_do_link>' : ''))));
  const comLimite = p => espera ? Promise.race([p, new Promise(ok => setTimeout(() => ok(null), espera))]) : p;
  const candidatos = linksDeFora(links, texto).slice(0, 3);
  const leituraSitios = Promise.all(candidatos.map(u => lerSitioCache(u).then(t => t ? { u, t } : null)));
  const [lido0, lig, sit] = await Promise.all([comLimite(leitura), comLimite(leituraLigados), comLimite(leituraSitios)]);
  const lido = lido0 || SEM_TWEET, sitios = (sit || []).filter(Boolean);
  // link ja lido aqui nao precisa ser aberto de novo pela IA
  const fora = linksDeFora(links, texto, lido.texto).filter(u => !sitios.some(x => x.u === u));
  const imagens = imagensUnicas(imagensDoBalao || [], lido.imagens);
  const rastro = { tweet: !!lido.texto, apagado: !!lido.apagado, ligados: ligados.map(s => 'https://x.com/' + s.replace('/', '/status/')), sitios: candidatos.map(u => ({ u, ok: sitios.some(x => x.u === u) })), fora: fora.slice(0, 4), imagens: imagens.length };
  return {
    fora, imagens, rastro,
    texto: (lido.apagado ? '\n\n<aviso>This tweet is no longer available on X (deleted, or the account went private/suspended). Mention it in risco.</aviso>' : '') +
      (lido.texto ? '\n\n<conteudo_dos_links>\n' + lido.texto + '\n</conteudo_dos_links>' : '') +
      (lig || []).join('') +
      sitios.map(x => '\n\n<pagina_lida url="' + x.u + '">\n' + x.t + '\n</pagina_lida>').join('') +
      (fora.length ? '\n\n<links_externos>\n' + fora.join('\n') + '\n</links_externos>' : '') +
      (imagens.length ? '\n\n(' + imagens.length + ' imagem(ns) do tweet anexada(s) acima: fotos ou capa de video.)' : '')
  };
}
// le no maximo 2 paginas e so o comeco de cada uma (controla o custo em tokens)
// abre no maximo 1 pagina e so o comeco dela (cada abertura leva varios segundos)
const FERRAMENTA_FETCH = { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 1, max_content_tokens: 2500 };
// Sonnet 5.5 (e Opus) tem a versao nova da busca e da leitura de pagina: filtra o resultado antes de ler, gasta menos tokens.
// O Haiku so aceita a versao basica.
const buscaNova = modelo => /sonnet-5|opus/i.test(modelo || '');
const ferramentaFetch = modelo => buscaNova(modelo) ? Object.assign({}, FERRAMENTA_FETCH, { type: 'web_fetch_20260209' }) : FERRAMENTA_FETCH;
const ferramentaBusca = (modelo, max) => ({ type: buscaNova(modelo) ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: max });

// Pedido com streaming: cada pedaco de texto chega em aoTexto enquanto a IA escreve. Devolve o texto inteiro no fim.
async function claudeStream({ modelo, system, user, imagens, tools, maxTokens, func, aoTexto, sinal }) {
  const { apiKey } = await chrome.storage.local.get({ apiKey: '' });
  if (!apiKey) throw new Error('SEM_CHAVE');
  await carregado; system = naLingua(system);   // resposta na lingua escolhida nas configuracoes
  const content = imagens && imagens.length ? imagens.map(url => ({ type: 'image', source: { type: 'url', url } })).concat([{ type: 'text', text: user }]) : user;
  const tIni = Date.now();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: sinal,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify(Object.assign({ model: modelo, max_tokens: maxTokens, stream: true, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }] }, tools && tools.length ? { tools } : {}, extrasModelo(modelo)))
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new Error((j.error && j.error.message) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  const leitor = r.body.getReader(), dec = new TextDecoder(); let buf = '', total = '', recusou = false; const uso = {};
  for (;;) {
    const { done, value } = await leitor.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const linha = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!linha.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(linha.slice(5)); } catch (e) { continue; }
      // erro no meio do stream (ex.: overloaded): vira erro, quem chamou decide se tenta de novo
      if (ev.type === 'error') { const e = new Error((ev.error && ev.error.message) || 'stream error'); e.status = /overload/i.test(e.message) ? 529 : 500; throw e; }
      {
        if (ev.type === 'message_start' && ev.message && ev.message.usage) Object.assign(uso, ev.message.usage);
        if (ev.type === 'message_delta' && ev.usage) Object.assign(uso, ev.usage);
        if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason === 'refusal') recusou = true;
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) { total += ev.delta.text; if (aoTexto) aoTexto(ev.delta.text); }
      }
    }
  }
  console.log('[Axiom Helper] ' + func + ': streamed in ' + ((Date.now() - tIni) / 1000).toFixed(1) + ' s');
  registrarUso(func, modelo, uso, Date.now() - tIni);
  return { texto: total.trim(), recusou };
}

// Resumo do tweet: o content.js abre a porta "resumir" e recebe o texto aos pedacos ({ delta }), depois { fim }.
// Sem a chave: { local, texto } com as frases principais traduzidas. Erro: { erro, semChave }.
// "5|": resumos feitos antes do glossario sao descartados
chrome.runtime.onConnect.addListener(porta => {
  if (porta.name !== 'resumir') return;
  let aberta = true; porta.onDisconnect.addListener(() => { aberta = false; });
  const enviar = m => { if (aberta) try { porta.postMessage(m); } catch (e) {} };
  porta.onMessage.addListener(async msg => {
    await carregado; await ccCarregado;
    const texto = String(msg.texto || ''), citado = String(msg.citado || ''), status = msg.status || '';
    const k = '5|' + idioma + '|' + norm(texto + '|' + citado + '|' + status);
    if (cacheResumo.has(k)) { enviar({ delta: cacheResumo.get(k) }); enviar({ fim: true }); return; }
    const ctrl = new AbortController(), tempo = setTimeout(() => ctrl.abort(), 75000);
    try {
      const { apiKey, modeloResumo } = await chrome.storage.local.get(PADRAO);
      if (!apiKey) {
        // sem a chave: so as 2 frases principais traduzidas. Nao fica salvo, para virar resumo de verdade quando a chave for colocada
        const trecho = resumoLocal(texto);
        enviar({ local: true, texto: (await traduzir(trecho)) || trecho }); return;
      }
      const lido = await Promise.race([lerTweet(status), new Promise(ok => setTimeout(() => ok(SEM_TWEET), 1500))]), imagens = imagensUnicas(msg.imagens || [], lido.imagens);   // a pre-busca do balao normalmente ja trouxe
      const user = 'Tweet:\n' + texto.slice(0, 3000) + (citado ? '\n\nTweet citado:\n' + citado.slice(0, 1200) : '') +
        (lido.texto ? '\n\nConteudo completo do tweet e do link (use isto para resumir; se for um artigo, resuma o que o artigo diz):\n' + lido.texto : '') +
        (imagens.length ? '\n\nAs imagens anexadas sao do tweet (fotos ou capa de video): considere o que aparece nelas.' : '');
      const args = { modelo: modeloResumo, system: GLOSSARIO + '\n' + SISTEMA_RESUMO, user, imagens, maxTokens: 1024, func: 'resumo', aoTexto: d => enviar({ delta: d }), sinal: ctrl.signal };
      let r;
      try { r = await claudeStream(args); }
      catch (e) {
        // imagem que a Anthropic nao conseguiu baixar: repete sem as imagens (nada foi enviado ainda)
        if (e.status === 400 && imagens.length && /image|url|download/i.test(e.message)) r = await claudeStream(Object.assign(args, { imagens: [] }));
        else throw e;
      }
      if (r.recusou && !r.texto) throw new Error(T('e_recusou'));
      if (r.texto) { cacheResumo.set(k, r.texto); salvarCC(); }
      enviar({ fim: true });
    } catch (e) {
      enviar(e.name === 'AbortError' ? { erro: T('e_demorou') } : { erro: erroAmigavel(e), semChave: String(e && e.message) === 'SEM_CHAVE' });
    } finally { clearTimeout(tempo); }
  });
});

// analise da NARRATIVA do tweet (nao da moeda): sem a base de conhecimento de memecoins, que puxava a analise para a moeda
// o glossario de termos vem primeiro (parte fixa, fica em cache)
function sistemaCheck() {
  return GLOSSARIO + '\n' +
    'ROLE: you fact-check the NARRATIVE behind a tweet for a memecoin trader who decides in seconds. ' +
    'On Axiom/GMGN each new coin shows the tweet that inspired it. The poster is almost never the coin owner: it is a random person, a celebrity (Elon, Trump, CZ...), ' +
    'a news outlet, or a tech/launchpad account. Judge the STORY (what happened, is it real), never the coin, price or whether to buy.\n' +
    'Optional <pesquisa_rapida>: automatic free lookups done before you (posts quoting this tweet, X posts found by keywords, Google News headlines of the last 7 days). ' +
    'They are leads, not proof: a headline from an established outlet counts as a source (name the outlet in fontes); X posts are claims; quotes saying "fake/old/AI" are hints to check; ' +
    'the oldest matching X post can show who posted it first. Keyword results may be about something else: ignore what does not match. ' +
    'INPUT: optional <moeda_no_axiom> (ticker and name of the coin the user is looking at, or the raw text of its card; it is the coin this tweet is attached to), ' +
    'optional <dados_do_axiom> (engagement of the tweet, verification badge, account year, bot flag and bio of the author and of the quoted/replied author, and the coin website/telegram/discord: ' +
    'use it to judge reach and whether an account is the official one, e.g. "verified Business" or "verified Government" with an old account is the real outlet/agency, a new account with no badge copying a famous name is likely fake; ' +
    'a famous claim with almost no views was not seen by anyone; do not list these numbers, only say what they mean when it matters), <tweet> (may be cut off), optional <tweet_citado_ou_resposta> (quoted/replied tweet: the real news is often there), ' +
    '<conteudo_dos_links> (full tweet text and shared article, already fetched: do not fetch again), <post_do_link> (an X post linked in the tweet, already fetched: use it to explain what the tweet refers to), <pagina_lida> (GitHub/Reddit/TikTok link already read through their API, with real numbers: do not fetch it again; a GitHub repo only proves the code exists, not who made it or how), <links_externos>, and attached images ' +
    '(read text in screenshots, the meme, the chart; screenshots can be fake or edited). A <tweet> starting with "Perfil do X:" is an account/community card, not a tweet: ' +
    'narrativa = who the account says it is and what it posts; veredito verdadeiro if bio/followers/verified match a known entity, falso + risco if it copies a known name or handle, else nao_verificavel. ' +
    'The <tweet> itself is real (the user is looking at it on X): a celebrity posting a meme or image = nao_verificavel, say who posted it and what the joke refers to. ' +
    'Only check a celebrity when someone ELSE claims they said or did something.\n' +
    'METHOD: 1) Find the ONE factual claim the narrative rests on (e.g. "the president posted this", "Binance listed it") and check only that. ' +
    'The claim may be in the earlier tweet: a reaction like \"lol\" in the <tweet> does not make the news a joke. ' +
    'Price predictions, opinions, jokes, hype, memes and dev promises are NOT facts: verdict nao_verificavel, use no tools. ' +
    '2) Use the sources the tweet already brings first: if <conteudo_dos_links>, <post_do_link> or <pagina_lida> do not settle it and there are <links_externos>, open (web_fetch) the ONE link that best settles the claim. ' +
    '3) If something needed for the verdict is still missing after that, ONE short search, picked by the claim: ' +
    'if it is "someone posted X", search X: site:x.com + the @ or name + 1-2 keywords (e.g. site:x.com Jaemyung_Lee 109); ' +
    'otherwise (product, launch, listing, event, news) search the web with the most distinctive exact name in quotes + the company/person (e.g. "ROOFUS 0.1" RoboStrategy), ' +
    'in the original language, looking for an official confirmation/denial or real coverage. A source the tweet cites that does not say what the tweet claims is a bad sign. ' +
    'A screenshot of a famous account\'s post that is not on that account and has no coverage = falso, risco \"print provavelmente editado\". ' +
    'A known news outlet\'s own headline with its article in the input = verdadeiro, unless the article contradicts the tweet. ' +
    'WHO SAID WHAT: the <tweet> author is the one posting NOW (often replying); <tweet_citado_ou_resposta> was written EARLIER by someone else (its author is named when known), ' +
    'and images in it were posted by that earlier author (a screenshot of a THIRD person\'s post shows what that third person allegedly said). If the earlier author is unknown, write \"outra conta\", never guess an @. Never swap them. Name people by their @ and keep the order: first what the earlier tweet said, then how the <tweet> author answered. ' +
    'THE COIN STORY: the moeda field explains why the coin in <moeda_no_axiom> exists from this tweet. When it is a reply, dispute or credit fight ' +
    '(copied video, wrong name, \"this is mine\", \"the real one\"), tell the whole chain in order in narrativa: who posted what first, which coin used it, ' +
    'which coin is the \"right\" one and why. If that chain is not clear from the input, search X for it: site:x.com + the coin name + the other name or the author (e.g. site:x.com Kaida Luna). ' +
    'If the coin name/ticker is not in the tweet, say what it points to (a word in the image, a nickname, the pet\'s name) or say plainly that the link is not clear; never invent it. ' +
    'Never mention numbers from <moeda_no_axiom> (age, holders, market cap, volume). ' +
    'Tweet in another language: tell the story in the output language; a foreign coin name gets its meaning in parentheses (e.g. **小狗** (cachorrinho)). ' +
    'Who really made the content IS a fact to check: search the claimant\'s own X posts for an EARLIER post of it (e.g. site:x.com DJ_SHO974 Kaida): an earlier post by them = they are the author (verdadeiro). ' +
    'A new account alone is NOT a risk (new projects have new accounts); only flag it if it impersonates someone who existed before. ' +
    'Today is ' + new Date().toISOString().slice(0, 10) + '. Never ask for more input.\n' +
    'Be DIRECT: give a clear verdict when the evidence points one way; do not hide behind nao_confirmado. Use what you know about the entity (what it is, what it does). ' +
    'Be SPECIFIC: names, dates, numbers, what the joke/reference is. Banned: vague filler like "hype-driven", "riding the wave", "sem fato a checar", "brincadeira de comentário". ' +
    'Crypto slang is allowed (runner, meta, CTO, dev...) but each term gets a 2-3 word explanation in parentheses (same for official, legal or technical terms and acronyms, e.g. MUD (distrito que paga água e esgoto de um bairro)), and the sentence must make the whole story clear: what happened, who did it, why people care. ' +
    'If unsure what an acronym means, say "provavelmente".\n' +
    'OUTPUT: ONLY valid JSON, no text outside it. Field VALUES in Brazilian Portuguese (with correct accents), simple everyday words, short direct sentences, ' +
    'as if explaining to a trader friend who did not see the news and reads it in 3 seconds. Subject + verb + what happened. Never leave out the context needed to understand it.\n' +
    '{"veredito":"verdadeiro|falso|parcial|nao_confirmado|nao_verificavel (falso = contradicted by facts, OR an official act of a real company/person (launch, product, listing, partnership, deal) ' +
    'that its official site/account/news do not show, especially when it does not fit what that entity is (e.g. an investment fund launching its own robot): say so directly; ' +
    'a video or clip of the person saying it themselves = verdadeiro (small caption or translation differences do not matter); ' +
    'nao_confirmado = plausible and too new or too small to verify either way; nao_verificavel = no fact: joke, opinion, prediction, hype)",' +
        '"manchete":"the bottom line in max 8 words, shown in bold right after the verdict badge, so the trader decides by reading only this (e.g. Vídeo antigo de 2019 reciclado; Elon postou mesmo, há 2 horas; Piada sobre o gato do dev)",' +
    '"narrativa":"ONE short sentence, max 22 words (two sentences, max 40 words, only when the story has several steps: cut adjectives, never a step), so EASY that someone who never heard of it understands at once: what happened, who did it. No jargon without a 2-3 word explanation. ' +
    'Ex.: Um vídeo de um filhote de elefante viralizou no X. Ex. 2: Alguém postou um vídeo de IA dizendo que era dele; o autor real, @DJ_SHO974, diz que o nome certo é **Kaida**.",' +
    '"checagem":"EMPTY when veredito is nao_verificavel (nothing to check). Otherwise ONE short sentence, max 22 words: the ONE reason for the verdict in everyday words, naming the source (e.g. o próprio vídeo, o site da empresa, a Reuters). ' +
    'Do NOT start with Sim/Não (the badge already says it). Do NOT describe how you checked (logos, watermarks, captions, frames, which excerpt, search terms) unless that detail IS the proof it is fake. ' +
    'If a search found nothing, say it simply (e.g. Só este post fala disso e a empresa não anunciou nada.). Never a vague \\"nenhuma fonte encontrada\\". ' +
    'Ex.: O vídeo é real e já tem **8,8 milhões de views**; só o nome do elefante não foi confirmado.",' +
    '"moeda":"ONE short sentence, max 16 words: how the coin in <moeda_no_axiom> connects to this story (the name/ticker comes from where, is it the original or a copy, which meta (current trend) it rides). Empty if there is no coin. Never prices or numbers of the coin. ' +
    'Ex.: **Backpack Elephant** usa o nome do elefante do vídeo, na meta de animais (moedas de bichos virais).",' +
'"risco":"only something SERIOUS that can fool a buyer (fake or hacked account, edited screenshot, old news recycled as new, invented partnership), max 8 words, else empty (empty is normal)",' +
    '"fontes":["at most 1 domain: the source that decided the verdict"]}\n' +
    'BOLD: wrap with **double asterisks** only what really matters to decide (the token, a decisive number, a denial), at most 1 short span per sentence.';
}

const LIMITE_BUSCA = 15000, LIMITE_LINKS = 20000;
async function verificar(texto, citado, quando, autor, status, links, extras = {}) {
  await carregado; await ccCarregado;
  // moeda: so as 2 primeiras palavras do card (ticker e nome); idade e numeros mudam a cada segundo e nunca bateriam no cache
  const moedaChave = (extras.moeda || '').split(/\s+/).slice(0, 2).join(' ');
  const k = '35|' + idioma + '|' + norm(texto + '|' + (citado || '') + '|' + (status || (autor || '') + '|' + (links || []).join(',')) + '|' + moedaChave);
  // "ainda nao da pra saber" vence em 15 min: a noticia pode ter sido confirmada depois
  const salvo = cacheCheck.get(k);
  if (salvo && !(salvo.veredito === 'nao_confirmado' && Date.now() - (salvo.t || 0) > 15 * 60 * 1000)) return salvo;
  // quem pediu com aoParcial recebe o card aos pedacos (tambem quando entra numa analise que ja estava em andamento)
  const f = extras.aoParcial; if (f) { if (!ouvintesCheck.has(k)) ouvintesCheck.set(k, new Set()); ouvintesCheck.get(k).add(f); }
  try { return await unico('c' + k, () => verificarRapido(texto, citado, quando, autor, status, links, k, extras)); }
  finally { if (f && ouvintesCheck.has(k)) { ouvintesCheck.get(k).delete(f); if (!ouvintesCheck.get(k).size) ouvintesCheck.delete(k); } }
}
const ouvintesCheck = new Map();   // chave da analise -> funcoes que recebem o resultado parcial
// JSON ainda sendo escrito: pega os campos que ja chegaram. O veredito so vale com a palavra inteira ("fal" ainda nao e "falso")
function lerParcial(bruto) {
  const o = lerJsonDaAnalise(bruto); if (!o) return null;
  const v = String(bruto).match(/"veredito"\s*:\s*"(verdadeiro|falso|parcial|nao_confirmado|nao_verificavel)"/);
  const txt = c => typeof o[c] === 'string' ? o[c].trim() : '';
  const p = { veredito: v ? v[1] : '', manchete: txt('manchete'), narrativa: txt('narrativa'), checagem: txt('checagem'), moeda: txt('moeda'), risco: txt('risco'), fontes: Array.isArray(o.fontes) ? o.fontes.slice(0, 1) : [] };
  return p.veredito || p.manchete ? p : null;
}
function userCheck(texto, citado, quando, autor, extra, seguidores, moeda, infos) {
  return (moeda ? '<moeda_no_axiom>\n' + String(moeda).slice(0, 250) + '\n</moeda_no_axiom>\n\n' : '') +
    (infos ? '<dados_do_axiom>\n' + String(infos).slice(0, 1200) + '\n</dados_do_axiom>\n\n' : '') + '<tweet' + (autor ? ' author="@' + autor + '"' : '') + (seguidores ? ' author_followers="' + String(seguidores).replace(/"/g, '') + '"' : '') +
    (quando ? ' date="' + quando + '"' : '') + '>\n' + texto.slice(0, 3000) + '\n</tweet>' +
    (citado ? '\n\n<tweet_citado_ou_resposta>\n' + citado.slice(0, 2500) + '\n</tweet_citado_ou_resposta>' : '') + (extra || '') +
    '\n\nThat is everything about the tweet (it may be cut off at the end, that is normal). Answer with the JSON. Do not ask for more.';
}
// tenta com as ferramentas pedidas; se a API recusar o web_fetch, repete sem ele; se o Haiku recusar a busca, tenta com o Sonnet
async function claudeComFerramentas(args) {
  try { return await claude(args); }
  catch (e) {
    if (e.status !== 400 || /credit|balance/i.test(e.message)) throw e;
    // imagem que a Anthropic nao conseguiu baixar: repete sem as imagens
    if (args.imagens && args.imagens.length && /image|url|download/i.test(e.message)) {
      console.log('[Axiom Helper] images rejected (' + e.message + '); retrying without them');
      return claudeComFerramentas(Object.assign({}, args, { imagens: [] }));
    }
    if (/fetch/i.test(e.message) && (args.tools || []).some(t => t.name === 'web_fetch')) return claudeComFerramentas(Object.assign({}, args, { tools: args.tools.filter(t => t.name !== 'web_fetch') }));
    if (/haiku/i.test(args.modelo) && /web_search|web_fetch|tool/i.test(e.message)) {
      const tools = (args.tools || []).map(t => t.name === 'web_search' ? ferramentaBusca('claude-sonnet-5-5', t.max_uses) : t.name === 'web_fetch' ? ferramentaFetch('claude-sonnet-5-5') : t);
      return claude(Object.assign({}, args, { modelo: 'claude-sonnet-5-5', tools }));
    }
    throw e;
  }
}
// le o JSON da analise mesmo quando a IA manda texto junto, bloco de codigo ou a resposta vem cortada no meio
const CAMPOS_TEXTO = ['veredito', 'manchete', 'narrativa', 'checagem', 'moeda', 'resumo', 'risco'];
function lerJsonDaAnalise(bruto) {
  const limpo = String(bruto || '').replace(/```(?:json)?/gi, '');
  try {
    const o = JSON.parse(limpo.slice(limpo.indexOf('{'), limpo.lastIndexOf('}') + 1));
    if (o && typeof o === 'object' && CAMPOS_TEXTO.some(c => c in o)) return o;
  } catch (e) {}
  // JSON quebrado ou cortado: recupera campo por campo (um texto cortado no fim tambem e aproveitado)
  const desescapar = s => s.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\');
  const campo = n => { const m = limpo.match(new RegExp('"' + n + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)')); return m ? desescapar(m[1]).trim() : ''; };
  const lista = n => { const m = limpo.match(new RegExp('"' + n + '"\\s*:\\s*\\[([^\\]]*)')); return m ? (m[1].match(/"((?:[^"\\\\]|\\\\.)*)"/g) || []).map(s => desescapar(s.slice(1, -1))) : []; };
  const o = { fontes: lista('fontes') };
  for (const c of CAMPOS_TEXTO) o[c] = campo(c);
  return CAMPOS_TEXTO.some(c => o[c]) ? o : null;
}
const completa = o => o && o.veredito && (o.narrativa || o.checagem || o.resumo);
function limparAnalise(r) {
  const txt = v => typeof v === 'string' ? v.trim() : '';
  r.veredito = (String(r.veredito || '').match(/verdadeiro|falso|parcial|nao_confirmado|nao_verificavel/) || ['nao_confirmado'])[0];
  r.manchete = txt(r.manchete); r.moeda = txt(r.moeda); r.narrativa = txt(r.narrativa); r.checagem = txt(r.checagem) || txt(r.resumo); r.risco = txt(r.risco);
  r.fontes = Array.isArray(r.fontes) ? r.fontes.filter(f => typeof f === 'string' && f.trim()).slice(0, 1) : [];
  r.buscar = r.buscar === true || r.buscar === 'true';
  return r;
}
// Uma etapa so: o modelo escolhido recebe tudo pronto (tweet completo, links, GitHub/Reddit, citacoes, busca no X, noticias)
// e so usa a busca na web se isso nao bastar. Sem resposta provisoria: o card ja mostra a analise final.
const PEDIDO_DIRETO = '\n\nNO SEARCH TOOL THIS TIME: the extension already searched for you (<pesquisa_rapida>: X posts, Bing/Google news with summaries, web results, sometimes the first article; <pagina_lida>: links of the tweet already read). ' +
  'Ignore the instructions above about searching; decide NOW with what is here. An established outlet or a Community Note in the input settles it. ' +
  'If a web_fetch tool is offered, use it only for a <links_externos> link the verdict depends on. ' +
  'If the claim is still not settled, use nao_confirmado and say in checagem exactly what is missing (e.g. Nenhuma notícia fala disso ainda; só este post.). Never say you will search.';
// fonte clicavel sem custo: troca o dominio que a IA citou pelo endereco exato que a propria extensao ja leu (noticias, links, posts); so busca de texto, sem rede nem IA
// historico das lupas (so no navegador, ultimas 40): o que a extensao viu e de que sites, para conferir depois
let filaLupa = Promise.resolve();
function registrarLupa(o, status, autor, texto) {
  filaLupa = filaLupa.then(() => chrome.storage.local.get({ lupalog: [] })).then(({ lupalog }) => {
    lupalog.push({ t: Date.now(), status: status || '', autor: autor || '', texto: String(texto || '').replace(/\s+/g, ' ').slice(0, 220), veredito: o.veredito, manchete: o.manchete || '', fontes: o.fontes || [], rastro: o.rastro });
    return chrome.storage.local.set({ lupalog: lupalog.slice(-40) });
  }).catch(() => {});
}
function fonteComLink(f, corpus, status) {
  if (typeof f !== 'string' || /^https?:\/\//.test(f)) return f;
  const d = f.trim().toLowerCase().replace(/^www\./, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return f;
  for (const m of String(corpus || '').match(/https?:\/\/[^\s"'<>\])]+/g) || []) {
    const u = m.replace(/[.,;:!?…]+$/, '');
    let h; try { h = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { continue; }
    if (h === d || h.endsWith('.' + d)) return u;
  }
  if ((d === 'x.com' || d === 'twitter.com') && /^[\w]{1,15}\/\d{15,20}$/.test(String(status || ''))) return 'https://x.com/' + status;   // fonte = o proprio tweet
  return 'https://' + d + '/';
}
async function verificarRapido(texto, citado, quando, autor, status, links, k, extras) {
  const cfg = await chrome.storage.local.get(PADRAO);
  const t0 = Date.now(), ehPerfil = /^Perfil do X:/.test(texto);
  // tudo comeca junto: fxtwitter, links, citacoes, busca no X e noticias. Espera no maximo 2,5 s pelos dados
  const pesquisa = ehPerfil ? Promise.resolve('') : pesquisaRapida(status, texto, citado, autor, links);
  const ate = (p, ms, vazio) => Promise.race([p, new Promise(ok => setTimeout(() => ok(vazio), ms))]);
  // Modo Turbo: espera menos pelos dados (1,2 s em vez de 2,5 s) e deixa a IA abrir o link sozinha so se precisar
  const espera = extras.turbo ? 1200 : 2500;
  const [ctx, pesq] = await Promise.all([contextoLinks(status, links, texto + '\n' + (citado || ''), extras.imagens, espera), ate(pesquisa, espera, '')]);
  console.log('[Axiom Helper] analysis: data ready in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s, ' + ctx.imagens.length + ' image(s), ' + ctx.fora.length + ' link(s)');
  // sempre as mesmas 2 ferramentas (1 leitura e 1 busca): o cache das instrucoes vale entre tweets com e sem link
  // sem busca da IA (cada rodada levava 3 a 8 s): a extensao ja buscou. So a leitura de 1 link que a extensao nao conseguiu abrir
  const tools = !ehPerfil && ctx.fora.length ? [ferramentaFetch(cfg.modeloCheck)] : [];
  // streaming: cada pedaco do JSON vira um card parcial para quem esta esperando (veredito e manchete aparecem primeiro)
  let ultimo = '';
  const corpus = [texto, citado, ctx.texto, pesq].join(' ');
  const aoTexto = t => { const p = lerParcial(t); if (p && p.fontes) p.fontes = p.fontes.map(f => fonteComLink(f, corpus, status)); const s = JSON.stringify(p); if (!p || s === ultimo) return; ultimo = s; for (const f of ouvintesCheck.get(k) || []) try { f(p); } catch (e) {} };
  const bruto = await claudeComFerramentas({ modelo: cfg.modeloCheck, system: sistemaCheck() + PEDIDO_DIRETO, imagens: ctx.imagens, tools, maxTokens: 3500, func: 'verificacao', aoTexto,
    limite: ctx.fora.length ? LIMITE_LINKS : LIMITE_BUSCA, user: userCheck(texto, citado, quando, autor, ctx.texto + pesq, extras.seguidores, extras.moeda, extras.infos) });
  const o = lerJsonDaAnalise(bruto);
  if (!completa(o)) { console.log('[Axiom Helper] analysis incomplete:', String(bruto).slice(0, 400)); throw new Error(T('e_incompleta')); }
  limparAnalise(o); o.fontes = (o.fontes || []).map(f => fonteComLink(f, corpus, status)); o.buscar = false;
  o.rastro = Object.assign({ t: Date.now(), ms: Date.now() - t0, modelo: cfg.modeloCheck }, (pesquisa && pesquisa.rastro) || {}, ctx.rastro || {});
  registrarLupa(o, status, autor, texto); o.t = Date.now(); cacheCheck.set(k, o); salvarCC();
  console.log('[Axiom Helper] analysis done in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  return o;
}

chrome.runtime.onMessage.addListener((msg, _s, responder) => {
  // balao de tweet abriu: ja busca o tweet completo (gratis), para o resumo e a lupa comecarem na hora do clique
  // a pesquisa gratis (citacoes, busca no X, noticias) tambem comeca aqui: no clique ela ja esta pronta e a IA nao espera 2,5 s
  if (msg.tipo === 'pesquisar') {
    if (msg.texto && !/^Perfil do X:/.test(msg.texto)) {
      pesquisaRapida(msg.status, msg.texto, msg.citado, msg.autor, msg.links);
      // adianta tambem a leitura dos links de dentro do tweet (GitHub, Reddit, TikTok, sites): no clique o cache ja esta quente
      contextoLinks(msg.status, msg.links, msg.texto + '\n' + (msg.citado || ''), msg.imagens, 2500).catch(() => {});
      aquecerApi();   // conexao com a api.anthropic.com ja quente para a primeira analise responder antes
    }
    responder({}); return false;
  }
  // Modo Turbo: o mouse parou na lupa -> ja comeca a analise. O resultado fica no cache/em andamento para o clique pegar na hora.
  if (msg.tipo === 'turbo') {
    if (msg.texto && !/^Perfil do X:/.test(msg.texto))
      verificar(msg.texto, msg.citado, msg.quando, msg.autor, msg.status, msg.links, { imagens: msg.imagens, seguidores: msg.seguidores, moeda: msg.moeda, infos: msg.infos, turbo: true }).catch(() => {});
    responder({}); return false;
  }
  if (msg.tipo === 'preparar') { lerTweet(msg.status).then(r => responder({ apagado: !!r.apagado })).catch(() => responder({})); return true; }
  if (msg.tipo === 'verificar') {
    verificar(msg.texto, msg.citado, msg.quando, msg.autor, msg.status, msg.links, { imagens: msg.imagens, seguidores: msg.seguidores, moeda: msg.moeda, infos: msg.infos }).then(r => responder({ ok: true, resultado: r })).catch(e => responder(respostaDeErro(e)));
    return true;
  }
  if (msg.tipo === 'abrirOpcoes') { chrome.runtime.openOptionsPage(); responder({ ok: true }); return false; }
  return false;
});
// analise pela porta "verificar": { parcial } a cada pedaco do JSON, depois { ok, resultado } (o mesmo do cache) ou { erro }
chrome.runtime.onConnect.addListener(porta => {
  if (porta.name !== 'verificar') return;
  let aberta = true; porta.onDisconnect.addListener(() => { aberta = false; });
  const enviar = m => { if (aberta) try { porta.postMessage(m); } catch (e) {} };
  porta.onMessage.addListener(msg => {
    verificar(msg.texto, msg.citado, msg.quando, msg.autor, msg.status, msg.links, { imagens: msg.imagens, seguidores: msg.seguidores, moeda: msg.moeda, infos: msg.infos, turbo: msg.turbo, aoParcial: p => enviar({ parcial: p }) })
      .then(r => enviar({ ok: true, resultado: r })).catch(e => enviar(respostaDeErro(e)));
  });
});


// =====================================================================
// Botao direito: "Resumir esta página"
// =====================================================================
// um de cada vez: "instalou" e "abriu o Chrome" podem chamar ao mesmo tempo, e criar duas vezes da erro de id duplicado
let filaMenu = Promise.resolve();
function criarMenu() {
  filaMenu = filaMenu.then(async () => {
    await carregado;   // o titulo do menu sai na lingua escolhida
    await new Promise(ok => chrome.contextMenus.removeAll(() => { void chrome.runtime.lastError; ok(); }));
    await new Promise(ok => chrome.contextMenus.create({ id: 'explicar', title: T('menu'), contexts: ['page', 'selection', 'frame', 'link'] },
      () => { void chrome.runtime.lastError; ok(); }));
  }).catch(() => {});
  return filaMenu;
}
// trocou a lingua nas configuracoes: atualiza o titulo do menu
chrome.storage.onChanged.addListener(ch => { if (ch.idioma) try { chrome.contextMenus.update('explicar', { title: T('menu') }, () => void chrome.runtime.lastError); } catch (e) {} });
chrome.runtime.onInstalled.addListener(criarMenu);
// clicar no icone da extensao abre a aba de configuracoes (se ja estiver aberta, so troca para ela)
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(criarMenu);
// Fora do Axiom e da GMGN a extensao nao fica carregada em todo site: o clique no menu da acesso a aba (activeTab)
// e o content.js entra so nessa hora. Se ele ja estiver la (Axiom, GMGN ou segundo clique), so manda o pedido.
// abre a conexao com a API ja no clique (TLS pronto quando o pedido sair, ~0,1-0,3 s a menos). Sem chave, sem custo
let aquecido = 0;
const aquecerApi = () => { if (Date.now() - aquecido < 45000) return; aquecido = Date.now(); fetch('https://api.anthropic.com/v1/messages', { method: 'HEAD', credentials: 'omit' }).catch(() => {}); };
// o "!" some quando a aba abre outra pagina
const comAviso = new Set();
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status !== 'loading' || !comAviso.has(id)) return;
  comAviso.delete(id); try { chrome.action.setBadgeText({ tabId: id, text: '' }); chrome.action.setTitle({ tabId: id, title: chrome.runtime.getManifest().action.default_title }); } catch (e) {}
});
const pedirResumo = id => new Promise(ok => chrome.tabs.sendMessage(id, { tipo: 'explicarPagina' }, { frameId: 0 }, r => { void chrome.runtime.lastError; ok(!!(r && r.ok)); }));
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'explicar' || !tab || tab.id == null) return;
  aquecerApi();
  if (await pedirResumo(tab.id)) return;
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['idiomas.js', 'termos.js', 'content.js'] }); }
  catch (e) {
    // paginas do Chrome, loja de extensoes, leitor de PDF...: antes nada acontecia; agora o icone mostra "!" com o motivo
    console.log('[Axiom Helper] cannot run on this page:', e.message);
    try { chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#f87171' }); chrome.action.setBadgeText({ tabId: tab.id, text: '!' }); chrome.action.setTitle({ tabId: tab.id, title: T('cantRunHere') }); comAviso.add(tab.id); } catch (e2) {}
    return;
  }
  pedirResumo(tab.id);
});

// Resumo de site: le o site inteiro (varias paginas em <site>) e diz em poucas linhas O QUE E e COMO FUNCIONA, com os numeros concretos
const SISTEMA_EXPLICAR =
  'Voce le um site inteiro (varias paginas, em <site>) e explica para um trader brasileiro de memecoins O QUE E e COMO FUNCIONA, do jeito mais curto possivel. ' +
  'Portugues do Brasil, formato EXATO:\n' +
  '1) uma primeira linha comecando com "Resumo: " com UMA frase de ate 25 palavras: o que e + a mecanica principal, com os numeros concretos do site. ' +
  'Exemplos do estilo certo: "Resumo: Launchpad onde voce ganha 60% das fees de cada moeda que lanca." / ' +
  '"Resumo: Jogo de token onde cada 0,1 SOL comprado te da um predio." / "Resumo: Bot de Telegram que copia as compras de carteiras escolhidas, cobrando 1% por trade."\n' +
  '2) depois, SO SE houver outras mecanicas importantes, ate 3 linhas comecando com "- ", cada uma com UM fato concreto (taxa, recompensa, como participar, token, prazo).\n' +
  'Use os numeros EXATOS do site e nunca invente. Sem marketing e sem adjetivos ("revolucionario", "inovador"). Se o site nao explicar como funciona, diga isso no Resumo. ' +
  'Se a ferramenta web_fetch for oferecida e as paginas lidas nao explicarem a mecanica, abra o link mais importante de <links_de_documentacao> (uma vez). ' +
  'Palavra tecnica ou giria: explique em 2-3 palavras entre parenteses. Sem introducao, sem conclusao, sem emojis, sem markdown alem dos hifens.';
// sempre: o site parece feito as pressas com IA ("vibecoded")? A extensao manda o resultado da auditoria automatica em <testes_do_site>
const VIBECODE = ' Por ultimo, SEMPRE escreva a linha "Cara de IA: " ' +
  '(comece com alta, media ou baixa, depois o motivo principal em ate 15 palavras) dizendo se o site parece feito as pressas com IA ou template ("vibecoded"). ' +
  'Base: <testes_do_site> (auditoria automatica: gerador de IA detectado, texto de exemplo esquecido, titulo padrao, links e botoes sem destino, ' +
  'chaves secretas expostas no codigo, arquivos com erro, enderecos de contrato) e o texto do site (frases genericas de marketing de IA, promessas vagas, falta de informacao concreta ' +
  'como equipe, contrato, documentacao, numeros verificaveis). Site feito com IA nao e golpe por si so: diga o que pesa. ' +
  'Chave secreta ou chave privada exposta no codigo e sinal grave (quem fez nao sabe o que esta fazendo, ou e golpe).';
// resumo de site fica salvo (chave = endereco + impressao digital do texto da pagina): reabrir o mesmo site e instantaneo, mesmo depois do service worker dormir
const cacheExplicar = new Map();
const ecCarregado = new Promise(ok => chrome.storage.local.get({ ecache: [] }, c => { try { (c.ecache || []).forEach(([k, v]) => cacheExplicar.set(k, v)); } catch (e) {} ok(); }));
const salvarEC = () => { try { chrome.storage.local.set({ ecache: Array.from(cacheExplicar.entries()).slice(-60) }); } catch (e) {} };
// o site ja diz a mecanica com numeros (taxa, %, supply...)? Entao a IA nao precisa abrir a documentacao (cada abertura leva 3-8 s)
const explicaMecanica = t => /\d[\d.,]*\s*(%|sol\b|eth\b|usdc\b|bps\b)/i.test(t) && /fee|taxa|reward|recompensa|tokenomics|supply|burn|queima|stak|airdrop|distribu|alloca/i.test(t);

// resposta em fluxo: as palavras comecam a aparecer em ~1s
chrome.runtime.onConnect.addListener(porta => {
  if (porta.name !== 'explicar') return;
  let aberta = true; porta.onDisconnect.addListener(() => { aberta = false; });
  const enviar = m => { if (aberta) try { porta.postMessage(m); } catch (e) {} };
  porta.onMessage.addListener(async msg => {
    await carregado; await ecCarregado;
    const k = 'v4|' + idioma + '|' + String(msg.chave || msg.url + '|' + String(msg.texto || '').length); if (msg.novo) cacheExplicar.delete(k);
    // 1a mensagem (antes de ler o site): so confere o cache
    if (msg.consulta) { enviar(cacheExplicar.has(k) ? { cache: cacheExplicar.get(k) } : { semCache: true }); return; }
    if (cacheExplicar.has(k)) { enviar({ delta: cacheExplicar.get(k) }); enviar({ fim: true }); return; }
    const ctrl = new AbortController(); const tempo = setTimeout(() => ctrl.abort(), 45000);
    try {
      const { apiKey, modeloResumo } = await chrome.storage.local.get(PADRAO);
      if (!apiKey) throw new Error('SEM_CHAVE');
      const sistema = GLOSSARIO + '\n' + SISTEMA_EXPLICAR + VIBECODE;
      const docs = (Array.isArray(msg.externos) ? msg.externos : []).filter(l => /^https?:\/\//.test(l)).slice(0, 3);
      // web_fetch so se a extensao nao conseguiu ler a documentacao e o site nao diz a mecanica
      const comFetch = docs.length > 0 && !explicaMecanica(String(msg.texto || ''));
      const user = '<site endereco="' + String(msg.url || '').slice(0, 200) + '" titulo="' + String(msg.titulo).replace(/"/g, "'") + '">\n' + String(msg.texto || '').slice(0, 24000) + '\n</site>' +
        (docs.length ? '\n\n<links_de_documentacao>\n' + docs.join('\n') + '\n</links_de_documentacao>' : '') +
        '\n\n<testes_do_site>\n' + (String(msg.tecnico || '').slice(0, 2000) || '(sem resultado)') + '\n</testes_do_site>';
      // documentacao em outro endereco: o Claude pode abrir 1 link; se a API recusar a ferramenta, pede de novo sem ela
      const args = { modelo: modeloResumo, system: sistema, user, maxTokens: 2048, func: 'explicar', aoTexto: d => enviar({ delta: d }), sinal: ctrl.signal,
        tools: comFetch ? [ferramentaFetch(modeloResumo)] : [] };
      let r, escreveu = false; const aoTexto = args.aoTexto; args.aoTexto = d => { escreveu = true; aoTexto(d); };
      try { r = await claudeStream(args); }
      catch (e) {
        if (e.status === 400 && comFetch) { console.log('[Axiom Helper] page summary: web_fetch refused, retrying without it'); r = await claudeStream(Object.assign(args, { tools: [] })); }
        // API sobrecarregada (529/5xx) antes de escrever qualquer coisa: tenta de novo uma vez sozinho
        else if ((e.status === 529 || e.status >= 500) && !escreveu && e.name !== 'AbortError') { await new Promise(ok => setTimeout(ok, 600)); r = await claudeStream(args); }
        else throw e;
      }
      const total = r.texto, recusou = r.recusou;
      if (recusou && !total) throw new Error(T('e_recusouPagina'));
      if (!total) throw new Error(T('e_semResposta'));
      cacheExplicar.delete(k); cacheExplicar.set(k, total); salvarEC();
      enviar({ fim: true });
    } catch (e) {
      enviar(e.name === 'AbortError' ? { erro: T('e_demorou') } : { erro: erroAmigavel(e), semChave: String(e && e.message) === 'SEM_CHAVE' });
    } finally { clearTimeout(tempo); }
  });
});

// =====================================================================
// Perguntas de acompanhamento (depois da verificacao ou do resumo da pagina)
// =====================================================================
const SISTEMA_PERGUNTA =
  'Voce conversa com um trader brasileiro de memecoins sobre o conteudo que ele acabou de ver (um tweet verificado ou uma pagina explicada). ' +
  'Responda em portugues do Brasil, direto, simples e curto (no maximo 80 palavras), em texto corrido ou ate 4 hifens, sem markdown alem disso e sem emojis. ' +
  'Use o conteudo e a resposta anterior como base. Se a pergunta pedir um fato que nao esta no conteudo, voce pode usar a busca na web; se nao achar, diga que nao sabe. ' +
  'Nunca invente fonte, numero ou noticia. Nao de conselho financeiro: de sua opiniao e os riscos. Hoje e ' + new Date().toISOString().slice(0, 10) + '.';
chrome.runtime.onMessage.addListener((msg, _s, responder) => {
  if (msg.tipo !== 'perguntar') return false;
  (async () => {
    const { modeloCheck, modeloResumo } = await chrome.storage.local.get(PADRAO);
    const hist = (Array.isArray(msg.historico) ? msg.historico : []).slice(-12).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content || '').slice(0, 1500) }));
    let primeiro, resposta, modelo, fora = [];
    if (msg.modo === 'pagina') {
      primeiro = '<pagina titulo="' + String(msg.titulo || '').replace(/"/g, "'") + '">\n' + String(msg.texto || '').slice(0, 12000) + '\n</pagina>';
      resposta = String(msg.resposta || '').slice(0, 2000); modelo = modeloResumo;
      // links da pagina (linha "Links:" ou docs): so com eles a IA pode abrir 1 pagina
      fora = [...new Set(primeiro.match(/https?:\/\/[^\s<>"')]+/g) || [])].slice(0, 12);
    } else {
      const ctx = await contextoLinks(msg.status, msg.links, String(msg.texto || '') + '\n' + String(msg.citado || ''));
      fora = ctx.fora;
      primeiro = userCheck(String(msg.texto || ''), String(msg.citado || ''), msg.quando, msg.autor, ctx.texto, msg.seguidores, msg.moeda, msg.infos);
      resposta = JSON.stringify(msg.resultado || {}).slice(0, 1500); modelo = modeloCheck;
    }
    const messages = [{ role: 'user', content: primeiro }, { role: 'assistant', content: resposta || 'ok' }, ...hist, { role: 'user', content: String(msg.pergunta || '').slice(0, 1000) }];
    // a base de memecoins so entra nas perguntas sobre pagina; sobre tweet a conversa e sobre a narrativa
    const sistema = msg.modo === 'pagina' ? BASE_PUMP + '\n\n' + SISTEMA_PERGUNTA.replace('voce pode usar a busca na web', 'voce pode abrir um link da pagina (se a ferramenta web_fetch for oferecida)') : GLOSSARIO + '\n\n' + SISTEMA_PERGUNTA;
    // pagina: sem busca na web (paga, ~US$0,01 por busca, e lenta); web_fetch (max 1) so quando ha links
    const tools = (msg.modo === 'pagina' ? [] : [ferramentaBusca(modelo, 2)]).concat(fora.length ? [ferramentaFetch(modelo)] : []);
    let t;
    try { t = await claude({ modelo, system: sistema, messages, tools, maxTokens: 1536, func: (msg.modo === 'pagina' ? 'pergunta_pagina' : 'pergunta_tweet') }); }
    catch (e) { if (e.status === 400 && !/credit|balance/i.test(e.message)) t = await claude({ modelo, system: sistema, messages, maxTokens: 1536, func: (msg.modo === 'pagina' ? 'pergunta_pagina' : 'pergunta_tweet') }); else throw e; }
    return t;
  })().then(t => responder({ ok: true, texto: t || T('e_semResposta') })).catch(e => responder(respostaDeErro(e)));
  return true;
});
