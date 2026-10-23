// Research Tool: traduz o tweet do balao (Axiom e GMGN), resume os longos e analisa a narrativa (so quando voce clica).
// Nos outros sites so entra quando voce usa "Resumir esta pagina" no botao direito.
(() => {
  if (window.__axiomTraduz) return;
  window.__axiomTraduz = true;
  const LOG = (...a) => console.log('[Axiom Helper]', ...a);
  LOG('active on', location.hostname);

  const feito = new WeakMap();
  const ignorar = /^(joined|bonding|quick buy)/i;
  // sites com balao de tweet: cada um monta o balao de um jeito (o resto da extensao e igual nos dois)
  //   SEL     = texto principal do tweet
  //   CARTAO  = cartao do balao (tweet ou perfil), com a cor do X
  //   JANELA  = camada flutuante em volta do cartao (onde a barra de botoes fica presa)
  const SITES = {
    axiom: { host: /(^|\.)axiom\.trade$/, SEL: 'span[class*="text-[18px]"]', CARTAO: 'div.group[class*="bg-[#15202B]"]', JANELA: '.z-elevated' },
    // tweet: cartao com a classe bg-[#15202B]; perfil: cartao "TweetContent" com a cor no style. Os dois usam SafeHtml no texto (tweet ou bio)
    gmgn: { host: /(^|\.)gmgn\.ai$/, SEL: '.pi-tooltip span[data-sentry-element="SafeHtml"]', JANELA: '.pi-tooltip',
      CARTAO: '.pi-tooltip-inner div[class*="bg-[#15202B]"], .pi-tooltip-inner [data-sentry-component="TweetContent"]' },
  };
  const SITE = Object.values(SITES).find(s => s.host.test(location.hostname)) || null;
  const SEL = (SITE || SITES.axiom).SEL;

  // lingua de destino (configuracoes > "Traduzir para"); a lista fica em idiomas.js
  let lingua = 'pt';
  try { chrome.storage.local.get({ idioma: 'pt' }, c => { lingua = IDIOMAS[c.idioma] ? c.idioma : 'pt'; }); } catch (e) {}
  // texto da interface na lingua escolhida (os textos ficam em idiomas.js)
  const T = (chave, a, b) => textoUI(lingua, chave, a, b);

  // o texto ja esta na lingua escolhida? Palpite rapido (palavras comuns e alfabeto) para nao gastar traducao com ele
  const PALAVRAS_EN = /\b(the|and|of|is|are|to|for|with|you|this|that|every|just|have|in|on|it|we|our)\b/gi;
  const contaEn = t => (t.replace(/https?:\/\/\S+/g, '').match(PALAVRAS_EN) || []).length;
  const conta = (t, re) => (t.match(re) || []).length;
  const fracao = (t, re) => { const l = t.replace(/[^\p{L}]/gu, ''); return l.length ? conta(l, re) / l.length : 0; };
  function jaNaLingua(t) {
    const s = t.replace(/https?:\/\/\S+/g, '');
    switch (lingua) {
      case 'pt': return /\b(que|não|você|para|com|uma|isso|está|são|mais)\b/i.test(s) && !/\b(the|and|is|to|of|you|this)\b/i.test(s);
      case 'en': return contaEn(s) >= 2 && fracao(s, /[a-z]/gi) > 0.9;
      case 'es': return conta(s, /\b(que|el|los|las|una|para|pero|muy|est[aá]|tambi[eé]n|porque)\b/gi) >= 2 && !/\b(the|and|is|você|não)\b/i.test(s);
      case 'zh': return fracao(s, /[一-鿿]/g) > 0.5 && !/[぀-ヿ]/.test(s);
      case 'ja': return /[぀-ヿ]/.test(s) && fracao(s, /[぀-ヿ一-鿿]/g) > 0.5;
      case 'ko': return fracao(s, /[가-힯]/g) > 0.5;
      case 'ru': return fracao(s, /[Ѐ-ӿ]/g) > 0.5;
      case 'tr': return conta(s, /\b(ve|bir|bu|için|çok|ama|değil|gibi)\b/gi) >= 2;
      case 'vi': return conta(s, /[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi) >= 3;
      case 'id': return conta(s, /\b(yang|dan|ini|untuk|dengan|tidak|akan|dari|kita|sudah)\b/gi) >= 2;
    }
    return false;
  }

  // ---- tradutor embutido do Chrome (local, gratis e sem limite, quando o navegador tem) ----
  // Detecta a lingua do texto (LanguageDetector do Chrome) para usar o par certo: chines -> portugues, nao so ingles -> portugues.
  let detector = null, detectorOk = true;
  async function detectarLingua(texto) {
    if (!detectorOk) return null;
    try {
      if (!detector) {
        if (!('LanguageDetector' in self) || (await LanguageDetector.availability()) !== 'available') { detectorOk = false; return null; }
        detector = await LanguageDetector.create();
      }
      const r = (await detector.detect(texto))[0];
      return r && r.confidence >= 0.6 && r.detectedLanguage !== 'und' ? r.detectedLanguage.split('-')[0] : null;
    } catch (e) { detectorOk = false; return null; }
  }
  const tradutores = new Map();   // "en>pt" -> tradutor do Chrome pronto, ou false (indisponivel ou baixando)
  const ESTADO_CHROME = { available: 'ready', downloadable: 'available to download (downloads on your first click on the page)', downloading: 'downloading', unavailable: 'not available in this Chrome' };
  let natPausa = 0;   // ate quando o tradutor do Chrome fica de lado (depois de falhar varias vezes)
  // modelo ainda nao baixado: o Chrome so deixa baixar depois de um clique do usuario na pagina
  function baixarNoClique(de, para, par) {
    addEventListener('pointerdown', async () => {
      try { tradutores.set(par, await Translator.create({ sourceLanguage: de, targetLanguage: para })); LOG('Chrome translator ready (' + par + ')'); }
      catch (e) { tradutores.delete(par); }
    }, { once: true, capture: true });
  }
  async function traduzirNativo(texto, de) {
    try {
      if (!('Translator' in self) || Date.now() < natPausa) return null;
      const para = idiomaDe(lingua).chrome;
      de = de || 'en';
      if (de === para) return null;
      const par = de + '>' + para;
      if (!tradutores.has(par)) {
        tradutores.set(par, false);   // enquanto pergunta a disponibilidade, os outros textos vao pelo Google
        const av = await Translator.availability({ sourceLanguage: de, targetLanguage: para });
        LOG('Chrome translator (' + par + '): ' + (ESTADO_CHROME[av] || av));
        if (av === 'available') tradutores.set(par, await Translator.create({ sourceLanguage: de, targetLanguage: para }));
        else if (av === 'downloadable' || av === 'downloading') baixarNoClique(de, para, par);
      }
      const t = tradutores.get(par);
      return t ? await t.translate(texto) : null;
    } catch (e) { natPausa = Date.now() + 60000; return null; }
  }

  // ================= traducao =================
  // o tradutor do Chrome as vezes devolve o texto sem traduzir: nesse caso a resposta e descartada e vale o tradutor online
  function naoTraduziu(orig, trad) {
    const a = orig.replace(/https?:\/\/\S+/g, '').trim().toLowerCase(), b = trad.replace(/https?:\/\/\S+/g, '').trim().toLowerCase();
    if (a === b) return true;
    if (lingua === 'en') return false;
    const en = contaEn(orig);
    return en >= 2 && contaEn(trad) >= en * 0.6;   // continuou em ingles
  }
  let falhasNativo = 0;
  async function nativoProtegido(texto, de) {
    const prot = proteger(texto);
    const t = await traduzirNativo(prot.txt, de);
    if (!t) return null;
    const r = restaurar(t, prot.mapa);
    return r.perdidos ? null : r.texto;   // o tradutor comeu alguma marca: usa o tradutor online, que tambem protege
  }
  // devolve { traducao, erro } ou { mesmaLingua: true } quando o texto ja esta na lingua escolhida
  function pedir(texto) {
    return new Promise(async res => {
      const de = await detectarLingua(texto);
      if (de && de === idiomaDe(lingua).chrome) return res({ traducao: null, mesmaLingua: true });
      if (soTermos(proteger(texto).txt)) return res({ traducao: null, mesmaLingua: true });   // so girias/links: nada a traduzir
      let nativo = await nativoProtegido(texto, de);
      if (nativo && naoTraduziu(texto, nativo)) {
        nativo = null;
        // falhou varias vezes seguidas: deixa o tradutor do Chrome de lado por 1 minuto
        // (link, data ou nome voltarem iguais e normal, nao e falha: so conta texto com 3+ palavras seguidas)
        if (/\p{L}{2,}(?:\s+\p{L}{2,}){2,}/u.test(texto) && ++falhasNativo >= 3) { falhasNativo = 0; natPausa = Date.now() + 60000; LOG('Chrome translator returned untranslated text; using Google for 1 minute'); }
      } else if (nativo) falhasNativo = 0;
      if (nativo) return res({ traducao: nativo, erro: '' });
      const fim = (t, erro) => res({ traducao: t || null, erro });
      try {
        chrome.runtime.sendMessage({ tipo: 'traduzir', texto }, r => {
          if (chrome.runtime.lastError) return fim(null, chrome.runtime.lastError.message);
          fim(r && r.traducao, (r && r.erro) || (r ? 'no translation returned' : 'no response from the extension background'));
        });
      } catch (e) { fim(null, String(e.message || e)); }
    });
  }
  // texto com as quebras de linha do tweet (<br>); textContent junta as linhas ("loucura!Soulja")
  const textoComQuebras = el => (el.innerText || el.textContent || '').trim();
  function nosDeTexto(raiz) {
    const w = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT), nos = []; let n;
    while ((n = w.nextNode())) nos.push(n);
    return nos;
  }
  // traducao automatica ligada/desligada (botao "PT" ao lado do balao; vale para todas as abas)
  let traduzLigado = true;
  let turbo = false;   // Modo Turbo: comeca a analise ao passar o mouse na lupa e espera menos pelos dados (mais rapido, custa um pouco mais)
  const trocados = new Map();   // no de texto traduzido -> texto original (para desfazer ao desligar)
  try {
    chrome.storage.local.get({ traducaoLigada: true, turbo: false }, c => {
      traduzLigado = c.traducaoLigada !== false; atualizarBotaoPT();
      turbo = c.turbo === true;
      if (!traduzLigado) LOG('Auto-translate is OFF: click the 文A button (first one in the balloon toolbar) to turn it on');
    });
    chrome.storage.onChanged.addListener(ch => {
      if (ch.turbo) turbo = ch.turbo.newValue === true;
      if (ch.traducaoLigada) aplicarTraducao(ch.traducaoLigada.newValue !== false);
      // trocou a lingua nas configuracoes: volta ao original e traduz de novo na lingua nova
      if (ch.idioma) {
        lingua = IDIOMAS[ch.idioma.newValue] ? ch.idioma.newValue : 'pt';
        LOG('now translating to: ' + idiomaDe(lingua).nome);
        desfazerTraducoes();
        if (traduzLigado) { agendado = true; requestAnimationFrame(varrerSeguro); }
      }
    });
  } catch (e) {}
  // volta o texto original de tudo que foi traduzido
  function desfazerTraducoes() {
    for (const [no, original] of trocados) {
      if (no.isConnected) { no.nodeValue = original; const pai = no.parentElement; if (pai && /^Original: /.test(pai.title)) pai.removeAttribute('title'); }
      feito.delete(no);
    }
    trocados.clear();
    document.querySelectorAll('[data-ax-bloco][title^="Original: "]').forEach(b => b.removeAttribute('title'));
    document.querySelectorAll('[data-ax-bloco]').forEach(b => blocoEstado.delete(b));
  }
  function aplicarTraducao(ligado) {
    if (ligado === traduzLigado) return;
    traduzLigado = ligado; atualizarBotaoPT();
    if (ligado) { agendado = true; requestAnimationFrame(varrerSeguro); return; }
    desfazerTraducoes();
  }

  // Paragrafo "picotado": na bio do perfil o Axiom poe cada palavra num <span> separado ("<span>Dig</span><span> with</span>...").
  // Palavra solta e curta demais para traduzir e perde o sentido, entao o paragrafo inteiro e traduzido de uma vez:
  // a traducao vai no primeiro pedaco e os outros ficam vazios (os elementos continuam la, so o texto muda).
  function blocosPicotados(raiz) {
    const lista = [];
    // texto com @mencoes/links no meio (bio e tweet da GMGN): traduz a frase inteira, nao os pedacos entre os links
    for (const el of raiz.querySelectorAll(SITE === SITES.gmgn ? SEL : ':not(*)')) {
      if (nosDeTexto(el).filter(n => n.nodeValue.trim()).length > 1 && el.textContent.trim().length >= 20) { el.dataset.axBloco = '1'; lista.push(el); }
    }
    for (const el of raiz.querySelectorAll('p, div')) {
      if (el.querySelector('p, div') || el.closest('.axpt, .axpt-barra, [data-ax-bloco]')) continue;   // so o nivel mais baixo
      const nos = nosDeTexto(el).filter(n => n.nodeValue.trim());
      if (nos.length < 4 || el.textContent.trim().length < 20) continue;
      if (ignorar.test(el.textContent.trim()) || /follow(ers|ing)/i.test(el.textContent)) continue;   // linha "Joined ... / 11.4M Followers"
      if (el.textContent.trim().length <= 70 && nos.some(n => RE_ARROBA.test(n.nodeValue.trim()))) continue;   // linha "Nome @usuario · 6h": o nome nao se traduz
      if (nos.filter(n => n.nodeValue.trim().length < 12).length < nos.length * 0.6) continue;   // a maioria precisa ser pedaco curto
      el.dataset.axBloco = '1'; lista.push(el);
    }
    return lista;
  }
  const blocoEstado = new WeakMap();   // paragrafo -> texto que ele tinha quando foi pedido/traduzido
  function traduzirBloco(el) {
    if (!traduzLigado) return;
    const nos = nosDeTexto(el), original = nos.map(n => n.nodeValue).join('');
    const txt = original.replace(/\s+/g, ' ').trim();
    if (curtoDemais(txt, 2) || jaNaLingua(txt) || blocoEstado.get(el) === original) return;
    blocoEstado.set(el, original);
    pedir(txt).then(r => {
      if (r.mesmaLingua) return;   // ja esta na lingua escolhida: fica como esta
      if (!r.traducao) avisarErroTraducao(r.erro);
      if (!r.traducao || !traduzLigado) { blocoEstado.delete(el); return; }
      if (nos.some(n => !n.isConnected) || nos.map(n => n.nodeValue).join('') !== original) { blocoEstado.delete(el); return; }   // o Axiom redesenhou
      nos.forEach((n, i) => { trocados.set(n, n.nodeValue); n.nodeValue = i === 0 ? r.traducao : ''; feito.set(n, n.nodeValue); });
      blocoEstado.set(el, r.traducao);
      el.title = 'Original: ' + txt;
      if (el.matches('[data-ax-principal]') || el.matches(SEL)) el.dataset.axTrad = textoComQuebras(el);
    });
  }

  // erro de traducao: se a extensao foi recarregada, esta aba ficou com a versao antiga desconectada (precisa de F5)
  let avisouRecarga = false;
  function avisarErroTraducao(erro) {
    if (/context invalidated|receiving end does not exist|extension context/i.test(String(erro))) {
      if (!avisouRecarga) { avisouRecarga = true; LOG('The extension was reloaded and this tab still runs the old version. Press F5 to translate again.'); }
    } else LOG('translation error:', erro);
  }
  // chines, japones e coreano nao tem espaco entre palavras e cada caractere ja diz muito ("真的非常的萌" = "muito fofo de verdade"):
  // a regra de tamanho minimo das linguas com espaco nao vale para eles
  const RE_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2}/u;
  const curtoDemais = (txt, nPal) => RE_CJK.test(txt) ? false : txt.length < 8 || (txt.length < 20 && nPal < 2);
  function traduzirNos(nos) {
    if (!traduzLigado) return;
    for (const no of nos) {
      if (no.parentElement && no.parentElement.closest('[data-ax-bloco], .axpt-barra')) continue;   // traduzido inteiro em traduzirBloco; a barra nao se traduz
      const original = no.nodeValue, txt = original.trim();
      const nPal = txt.split(/\s+/).length;
      if (curtoDemais(txt, nPal) || !/\p{L}{3}/u.test(txt) || ignorar.test(txt) || jaNaLingua(txt) || /^https?:\/\/\S+$/.test(txt)) continue;
      if (feito.get(no) === original) continue;
      feito.set(no, original);
      pedir(txt).then(r => {
        if (r.mesmaLingua) return;   // ja esta na lingua escolhida: fica como esta (e nao pede de novo)
        if (!r.traducao) { avisarErroTraducao(r.erro); setTimeout(() => feito.delete(no), 8000); return; }
        if (!traduzLigado) { feito.delete(no); return; }
        if (!no.isConnected || no.nodeValue !== original) return;
        no.nodeValue = original.split(txt).join(r.traducao);
        feito.set(no, no.nodeValue);
        trocados.set(no, original);
        if (trocados.size > 800) for (const n of trocados.keys()) if (!n.isConnected) trocados.delete(n);
        const pai = no.parentElement;
        if (pai) { pai.title = 'Original: ' + txt; const sp = pai.closest(SEL); if (sp) sp.dataset.axTrad = textoComQuebras(sp); }
      });
    }
  }

  // ================= baloes de resumo e verificacao =================
  const css = document.createElement('style');
  css.textContent = `
  .axpt{position:fixed;z-index:2147483647;box-sizing:border-box;font:13px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e6e7ea;
    background:rgba(16,17,21,.97);border:1px solid #262830;border-radius:12px;padding:11px 14px 12px;
    box-shadow:0 14px 34px rgba(0,0,0,.5),0 1px 0 rgba(255,255,255,.04) inset;backdrop-filter:blur(8px);animation:axptIn .14s ease-out}
  .axpt.resumo{border-top:2px solid #6d8bff}.axpt.analise{border-top:2px solid var(--ax-cor,#6d8bff)}
  @keyframes axptIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
  .axpt::-webkit-scrollbar{width:8px}.axpt::-webkit-scrollbar-thumb{background:#2a2c34;border-radius:8px}
  .axpt-hd{display:flex;align-items:center;gap:7px;margin:0 0 8px;padding-right:22px;min-height:20px}
  .axpt-hd svg{flex:none;color:#7f8cff}.axpt.analise .axpt-hd svg{color:var(--ax-cor,#7f8cff)}
  .axpt-hd .axpt-tag{flex:1;min-width:0;margin:0;font-size:12px;font-weight:600;color:#c9cbd1;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .axpt-vb{font-size:11.5px;font-weight:600;border-radius:999px;padding:2px 9px;white-space:nowrap}
  .axpt-it{margin:0 0 9px}.axpt-it:last-child{margin-bottom:0}
  .axpt-it-l{font-size:10.5px;font-weight:600;color:#7d808a;text-transform:uppercase;letter-spacing:.05em;margin-bottom:1px}
  .axpt-it-v{color:#dfe0e4;line-height:1.5}
  .axpt-fs{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}
  .axpt-fs a,.axpt-fs span{font-size:11.5px;color:#a9b4ff;background:#171a24;border:1px solid #252a3b;border-radius:999px;padding:2px 9px;text-decoration:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .axpt-fs a:hover{background:#1e2232;color:#c5cdff}
  .axpt-rs{margin-top:10px;font-size:12px;color:#9a9da6}.axpt-rs summary{cursor:pointer;color:#7a7d86;user-select:none}.axpt-rs summary:hover{color:#c9cbd1}
  .axpt-rs-b{margin-top:6px;max-height:260px;overflow:auto;line-height:1.45}.axpt-rs-s{margin:6px 0 0}.axpt-rs-s b{color:#c9cbd1;font-weight:600}
  .axpt-rs ul{margin:3px 0 0;padding-left:16px}.axpt-rs li{margin:0 0 3px}.axpt-rs a{color:#a9b4ff;text-decoration:none}.axpt-rs a:hover{text-decoration:underline}.axpt-rs-m{color:#6f727b}
  .axpt-tag{font-size:11.5px;font-weight:600;color:#8a8d96;margin-bottom:5px}
  .axpt-txt{margin:0}
  .axpt-mudo{color:#8a8d96}
  .axpt-barra{position:absolute;z-index:2147483647;display:flex;flex-direction:column;gap:3px;box-sizing:border-box;width:40px;padding:3px;
    background:#15202B;border:1px solid #2f3b47;border-radius:9px;box-shadow:0 2px 10px rgba(0,0,0,.45)}
  .axpt-barra::after{content:'';position:absolute;top:0;bottom:0;right:100%;width:8px}
  .axpt-barra.esq::after{right:auto;left:100%}
  .axpt.analise .axpt-x{display:none}
  .axpt-pill{box-sizing:border-box;color:#a6a9b2;background:transparent;border:0;border-radius:6px;width:32px;height:32px;padding:0;
    display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .1s,color .1s}
  .axpt-pill:hover{background:#22303c;color:#fff}
  .axpt-pill svg{width:17px;height:17px}.axpt-pt-bt svg{width:19px;height:19px}
  .axpt-chip{box-sizing:border-box;display:flex;align-items:center;justify-content:center;height:32px;width:32px;padding:0;margin-top:2px;border-top:1px solid #2f3b47;
    font:700 11.5px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#8a8d96;white-space:nowrap;cursor:default}
  .axpt-chip svg{margin-left:5px;opacity:.7}
  .axpt-chip.ca{color:#c4c6cc;cursor:pointer;border-radius:0 0 6px 6px}.axpt-chip.ca:hover{background:#22303c;color:#fff}.axpt-chip.ca:hover svg{opacity:1}
  .axpt-pill.on{color:#8fa5ff;background:#1c2340}
  .axpt-pt-bt.on{color:#8fa5ff;background:#1c2340}
  .axpt-pt-bt.on:hover{background:#232c50}
  .axpt-pt-bt:not(.on){color:#5f626b}
  .axpt-v{display:inline-block;font-size:11.5px;font-weight:600;border-radius:5px;padding:1px 7px;margin-left:4px;vertical-align:1px}
  .axpt-narr{margin:0 0 2px;font-weight:600;line-height:1.45}
  .axpt-tps{margin:2px 0 0;padding-left:15px}.axpt-tps li{margin:0 0 6px;line-height:1.45;color:#c4c6cc}.axpt-tps li::marker{color:#5f626b}
  .axpt-tp{font-weight:600;color:#e6e7ea}.axpt-tp .axpt-v{margin-left:2px}
  .axpt-sec{margin-top:6px}
  .axpt-sec-t{font-size:11.5px;font-weight:600;color:#8a8d96;margin-bottom:2px}
  .axpt-f{margin-top:7px;font-size:11.5px;color:#7a7d86}
  .axpt-al{margin-top:10px;background:rgba(224,164,88,.07);border:1px solid rgba(224,164,88,.22);border-radius:8px;padding:7px 10px 6px}
  .axpt-al-t{display:flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:#e0a458;margin-bottom:2px}
  .axpt-al ul{margin:0;padding-left:15px}.axpt-al li{font-size:12.5px;line-height:1.45;color:#c4c6cc;margin:1px 0}.axpt-al li::marker{color:#e0a458}
  .axpt-x{position:absolute;top:9px;right:9px;cursor:pointer;color:#7a7d86;font-size:16px;line-height:1;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:5px}
  .axpt-x:hover{color:#fff;background:#22242b}
  .axpt-q{position:relative;margin-top:11px}
  .axpt-q input{box-sizing:border-box;width:100%;background:#0b0c0f;color:#e6e7ea;border:1px solid #2a2c33;border-radius:9px;padding:7px 38px 7px 10px;font:12.5px system-ui,-apple-system,"Segoe UI",sans-serif;outline:none;transition:border-color .12s}
  .axpt-q input:focus{border-color:#5465b8}
  .axpt-q button{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:27px;height:25px;display:flex;align-items:center;justify-content:center;
    background:#4f63d6;color:#fff;border:0;border-radius:7px;padding:0;cursor:pointer;transition:background .12s}
  .axpt-q button:hover{background:#5d72ea}
  .axpt-q button:disabled{background:#2a2d35;color:#7a7d86;cursor:default}
  .axpt-qa{margin-top:6px;font-size:12.5px;line-height:1.5}.axpt-qa .q{color:#e6e7ea;font-weight:600;margin:10px 0 2px}.axpt-qa .a{white-space:pre-wrap;color:#c4c6cc}
  .axpt-a{color:#8fa5ff;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
  .axpt-pt::after{content:'';animation:axptP 1.2s steps(4,end) infinite}
  @keyframes axptP{0%{content:''}25%{content:'.'}50%{content:'..'}75%{content:'...'}}`;
  document.documentElement.appendChild(css);

  const VER = {
    // [chave do texto em idiomas.js, cor]
    verdadeiro: ['vTrue', '#4ade80'], falso: ['vFalse', '#f87171'], parcial: ['vPartly', '#fbbf24'],
    nao_confirmado: ['vUnconfirmed', '#9ca3af'], nao_verificavel: ['vUnverifiable', '#9ca3af']
  };
  const ICO = {
    lixo: '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.5h13M8 5.5V3.5h4v2M5.5 5.5l1 11h7l1-11"/></svg>',
    resumo: '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 5h12M4 10h12M4 15h7"/></svg>',
    lupa: '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4.5 4.5"/></svg>',
    alerta: '<svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3l8 14H2z"/><path d="M10 8v4M10 14.5v.5"/></svg>',
    enviar: '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h12M11 5l5 5-5 5"/></svg>',
    copiar: '<svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 7V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3"/></svg>',
  };
  // cabecalho dos cards: icone + titulo (+ selo a direita) e o X de fechar
  const cabecalho = (ico, titulo, extra) => '<span class="axpt-x" title="' + esc(T('close')) + '">\u00d7</span><div class="axpt-hd">' + ico + '<div class="axpt-tag">' + esc(titulo) + '</div>' + (extra || '') + '</div>';
  const EL = (cls, html) => { const d = document.createElement('div'); d.className = cls; if (html) d.innerHTML = html; return d; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let ui = null;            // {chave, resumo, pill, check, rect}
  let hover = false;
  // o Axiom as vezes so esconde o balao (sem tirar da pagina): conta como sumido se nao estiver visivel
  const visivel = el => !!el && el.isConnected &&
    (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);

  // quando o balao fecha, o resumo e a analise fecham junto
  let soltos = [];
  function limparUI() {
    if (!ui) return;
    [ui.barra, ui.resumo, ui.check].forEach(e => e && e.remove());
    ui = null;
  }
  function fecharSoltos() { soltos.forEach(e => e.remove()); soltos = []; }
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    fecharSoltos();
    if (ui) [ui.check, ui.resumo].forEach(c => { const x = c && c.querySelector('.axpt-x'); if (x) x.click(); });
  }, true);
  // ================= o cartao do balao =================
  // O balao do Axiom (tweet ou perfil) e sempre o mesmo cartao com a cor do X, dentro de uma janela fixa:
  //   div.pointer-events-auto.fixed.z-elevated          <- janela (onde a barra de botoes fica presa)
  //     ... div.relative.w-[300px].overflow-y-auto
  //           div.group.bg-[#15202B]                     <- cartao (tudo e lido e traduzido aqui dentro)
  // Tudo sai do cartao: texto principal, autor, horario, links, tweet citado e posicao.
  // Na GMGN: div.pi-tooltip (janela) > .pi-tooltip-inner > ... > div.bg-[#15202B] (cartao) > span[SafeHtml] (texto)
  const SEL_CARTAO = (SITE || SITES.axiom).CARTAO;
  // reserva para quando nao houver cartao (o Axiom mudou a cor): primeira caixa fixed/absolute do tamanho de um balao
  function caixaFlutuante(el) {
    for (let i = 0; i < 40 && el && el !== document.body; i++, el = el.parentElement) {
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if ((cs.position === 'fixed' || cs.position === 'absolute') && r.width >= 200 && r.width <= 700) return el;
    }
    return null;
  }
  // area do balao: o cartao (ou, na reserva, a caixa flutuante)
  const areaDe = el => el.closest(SEL_CARTAO) || caixaFlutuante(el) || el.parentElement || el;
  // o texto principal e de um tweet (e nao a bio de um perfil)? Na GMGN a bio usa o mesmo elemento do tweet:
  // la, so e tweet se o cartao tiver o link do tweet (x.com/.../status/...)
  const ehTweetP = p => p.matches(SEL) && !(SITE === SITES.gmgn && !areaDe(p).querySelector('a[href*="/status/"]'));
  // janela do balao: a camada fixa em volta do cartao
  const janelaDe = el => el.closest((SITE || SITES.axiom).JANELA) || caixaFlutuante(el);

  // barra de botoes em pe, do lado direito do balao, por fora. No HTML ela fica DENTRO da janela (so a posicao e fora),
  // assim passar o mouse nela conta como estar no balao e o Axiom nao fecha; uma ponte invisivel cobre o vao entre os dois.
  const ALTURA_BARRA = 40, LARGURA_BARRA = 40, VAO = 6;
  function prenderBarra() {
    if (!ui || !ui.barra || !ui.span) return;
    const b = ui.barra;
    const pai = janelaDe(ui.span);
    const abriga = pai && /^visible( visible)?$/.test(getComputedStyle(pai).overflow);   // balao que corta o que sai dele nao serve
    const r = abriga ? pai.getBoundingClientRect() : (ui.rect || (pai || ui.span).getBoundingClientRect());
    const direita = r.right + LARGURA_BARRA + VAO + 4 <= innerWidth;   // sem espaco a direita da tela: vai para a esquerda do balao
    ui.barraEsq = !direita; ui.barraEmbaixo = false;
    b.classList.toggle('esq', !direita);
    if (abriga) {
      if (b.parentElement !== pai) pai.appendChild(b);
      Object.assign(b.style, { position: 'absolute', top: '0', bottom: 'auto', left: direita ? 'calc(100% + ' + VAO + 'px)' : 'auto', right: direita ? 'auto' : 'calc(100% + ' + VAO + 'px)' });
    } else {
      if (b.parentElement !== document.body) document.body.appendChild(b);
      Object.assign(b.style, { position: 'fixed', top: r.top + 'px', bottom: 'auto', right: 'auto', left: (direita ? r.right + VAO : r.left - LARGURA_BARRA - VAO) + 'px' });
    }
  }
  function atualizarBotaoPT() {
    const b = ui && ui.pillPT; if (!b) return;
    b.classList.toggle('on', traduzLigado);
    b.title = T(traduzLigado ? 'autoOn' : 'autoOff');
  }
  const caixaDoBalao = el => (janelaDe(el) || areaDe(el)).getBoundingClientRect();
  const contaPalavras = t => (t.trim().match(/\S+/g) || []).length;
  // o botao de resumo aparece em todo tweet com texto
  const precisaResumo = (o, c) => contaPalavras(o) + contaPalavras(c) > 0;
  const hash = t => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return String(h); };

  // le o cartao: texto principal (original, mesmo depois de traduzido), autor (@), horario e tweet citado/respondido
  const RE_HORA = /\d{1,2}:\d{2}\s?[AP]M,?\s+\w{3}\s+\d{1,2},\s+\d{4}/;
  // texto original de um no (de quem ja foi traduzido, o original fica guardado no title)
  const originalDe = n => ((n.parentElement && n.parentElement.closest('[title^="Original: "]')) || {}).title;
  // cartao de perfil: descreve a conta inteira (nome, @, bio, data de criacao, seguidores) com os textos originais
  function descreverPerfil(cartao) {
    const partes = [], vistos = new Set();
    for (const n of nosDeTexto(cartao)) {
      if (!n.parentElement || n.parentElement.closest('.axpt-barra, button')) continue;
      const tit = originalDe(n);
      if (tit) { if (!vistos.has(tit)) { vistos.add(tit); partes.push(tit.replace(/^Original: /, '')); } continue; }
      if (n.nodeValue.trim()) partes.push(n.nodeValue);
    }
    return 'Perfil do X: ' + partes.join(' ').replace(/\s+/g, ' ').trim();
  }
  // Axiom: tweet so pelos dados do React (pagina.js), sem varrer a tela. GMGN e cartao de perfil nao tem esses dados: leem a tela
  const PELO_REACT = SITE !== SITES.gmgn;
  function lerBalao(principal) {
    const area = areaDe(principal);
    const ehPerfil = area.matches(SEL_CARTAO) && !ehTweetP(principal);
    if (PELO_REACT && !ehPerfil) return lerPeloReact(principal);
    const orig = ehPerfil ? descreverPerfil(area) : principal.dataset.axOrig || textoComQuebras(principal);
    let autor = '', quando = ''; const blocos = [];
    // 1o @ = autor do tweet principal; o 1o @ diferente = autor do tweet citado/respondido (a IA nao pode trocar quem disse o que)
    let autorCitado = '';
    for (const a of area.querySelectorAll('a')) {
      const m = a.textContent.trim().match(/^@([A-Za-z0-9_]{1,15})$/); if (!m || principal.contains(a)) continue;
      // "Respondendo a @x" nao e autor de nada que esteja no balao
      if (/replying to|respondendo a|en respuesta a/i.test((a.parentElement && a.parentElement.textContent) || '')) continue;
      if (!autor) autor = m[1]; else if (m[1].toLowerCase() !== autor.toLowerCase()) { autorCitado = m[1]; break; }
    }
    for (const n of nosDeTexto(area)) {
      const pai = n.parentElement;
      if (principal.contains(n) || !pai || pai.closest('.axpt-barra')) continue;
      if (!quando) { const m = n.nodeValue.match(RE_HORA); if (m) { quando = m[0]; continue; } }
      if (ehPerfil) continue;   // no perfil, tudo ja entrou na descricao
      // usa o texto original de quem ja foi traduzido (guardado no title)
      const original = (originalDe(n) || '').replace(/^Original: /, '');
      const base = (original || n.nodeValue).trim();
      if (base.length > 25 && !/^(joined|bonding|quick buy)/i.test(base) && !/^[\d.,]+[kmb]?\s*(followers|following|seguidores)/i.test(base) && !orig.includes(base) && !blocos.includes(base)) blocos.push(base);
    }
    // alcance do autor: o cartao mostra "8.92M followers" (pesa muito: tweet de famoso x de pessoa comum)
    // junta os pedacos com espaco: na GMGN "Feb 2012" e "11.4M" ficam colados no textContent ("201211.4M")
    const seg = (nosDeTexto(area).map(n => n.nodeValue).join(' ').match(/(?:^|\s)([\d.,]+\s?[KMB]?)\s*followers/i) || [])[1] || '';
    return { orig, citado: ((autorCitado && blocos.length ? 'Escrito por @' + autorCitado + ':\n' : '') + blocos.join('\n')).slice(0, 2500), quando, autor, seguidores: seg.replace(/\s/g, ''), imagens: imagensDoBalao(area), moeda: '', infos: null, ...linksDoBalao(principal) };
  }
  function lerPeloReact(span) {
    const orig = span.dataset.axOrig || textoComQuebras(span);
    const d = dadosDaPagina(span), t = d.tweet && mesmoTweet(d.tweet.x, orig) ? d.tweet : null;
    const r = { orig, citado: '', quando: '', autor: '', seguidores: '', imagens: [], status: t ? '' : d.statusMoeda || '', links: [], moeda: d.moeda || '', infos: null };
    if (d.sociais) r.infos = { sociais: d.sociais };
    if (!t) return r;   // dados ainda nao carregaram: tenta de novo na proxima mudanca do balao
    r.autor = t.u; r.quando = t.d;
    if (t.f != null) r.seguidores = numCurto(t.f);
    if (t.x.length > orig.length + 20) r.orig = t.x;   // a tela cortou o texto ("Show more")
    const outro = t.q || t.r;
    if (outro) r.citado = ('Escrito por @' + outro.u + (t.q ? ' (tweet citado)' : ' (tweet respondido)') + ':\n' + outro.x).slice(0, 2500);
    // retweet: o tweet e de @t.u; quem repostou (ex.: Elon) e o que move a moeda
    if (t.rtPor && t.rtPor.u) r.citado = ('Repostado (retweet, sem comentario) por @' + t.rtPor.u + (t.rtPor.n ? ' (' + t.rtPor.n + (t.rtPor.f != null ? ', ' + numCurto(t.rtPor.f) + ' seguidores' : '') + ')' : '') + '. O tweet abaixo e de @' + t.u + '.' + (r.citado ? '\n\n' + r.citado : '')).slice(0, 2500);
    r.status = t.u + '/' + t.id;
    r.links = t.l.filter(h => /^https?:\/\//.test(h) && !/^https?:\/\/(www\.)?(x|twitter)\.com\/(?!i\/article\/)/.test(h)).slice(0, 3);
    r.imagens = Array.from(new Set(t.m.concat(outro ? outro.m : []).filter(src => RE_MIDIA.test(src)))).slice(0, 3);
    r.infos = { e: t.e, c: t.c, u: t.u, outro: outro ? { u: outro.u, c: outro.c, e: outro.e } : null, sociais: d.sociais || null };
    return r;
  }
  // o texto do React e o mesmo tweet que esta na tela? (compara as primeiras palavras)
  function mesmoTweet(a, b) {
    const pal = x => String(x).toLowerCase().replace(/https?:\/\/\S+/g, ' ').match(/[\p{L}\p{N}]{3,}/gu) || [];
    const pa = pal(a).slice(0, 8), pb = new Set(pal(b));
    if (!pa.length || !pb.size) return true;   // tweet so com foto/video
    return pa.filter(w => pb.has(w)).length >= Math.ceil(pa.length / 2);
  }
  const numCurto = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);
  // pede ao pagina.js os dados do React a partir de um elemento (troca sincrona por eventos do DOM)
  const memoDados = new WeakMap();
  function dadosDaPagina(el) {
    if (!el) return {};
    // (o Axiom reaproveita o balao para outro tweet: texto diferente = le de novo)
    const m = memoDados.get(el), agora = performance.now(), txt = el.textContent;
    if (m && agora - m.t < 300 && m.txt === txt) return m.r;
    const r = lerDadosDaPagina(el); memoDados.set(el, { t: agora, txt, r }); return r;
  }
  function lerDadosDaPagina(el) {
    try {
      el.setAttribute('data-ax-alvo-dados', '1');
      // o evento sai do proprio elemento: o pagina.js nao precisa procurar na pagina inteira
      el.dispatchEvent(new CustomEvent('axpt-pedir-dados', { bubbles: true }));
      const s = el.getAttribute('data-ax-dados');
      return s ? JSON.parse(s) : {};
    } catch (e) { return {}; } finally { el.removeAttribute('data-ax-alvo-dados'); el.removeAttribute('data-ax-dados'); }
  }
  // imagens do tweet no balao (fotos e capas de video), sem foto de perfil e banner
  const RE_MIDIA = /^https:\/\/pbs\.twimg\.com\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//;
  function imagensDoBalao(area) {
    const lista = [];
    for (const img of area.querySelectorAll('img')) { const src = img.currentSrc || img.src || ''; if (RE_MIDIA.test(src) && !lista.includes(src)) lista.push(src); }
    // a GMGN poe o video num iframe (srcdoc): a capa fica no atributo poster do <video>
    for (const f of area.querySelectorAll('iframe[srcdoc]')) for (const m of f.srcdoc.matchAll(/poster="([^"]+)"/g)) if (RE_MIDIA.test(m[1]) && !lista.includes(m[1])) lista.push(m[1]);
    return lista.slice(0, 3);
  }

  // mensagem de espera com contador de segundos; desiste sozinha se a resposta nao chegar (retorna a funcao que para tudo)
  function esperando(p, texto, aoDesistir) {
    const t0 = Date.now();
    const mostrar = () => { const s = Math.round((Date.now() - t0) / 1000); p.innerHTML = esc(texto) + (s >= 3 ? ' · ' + s + ' s' : '') + '<span class="axpt-pt"></span>' + (s >= 8 ? '<br><span style="font-size:11.5px">' + esc(T('webWait')) + '</span>' : ''); };
    mostrar();
    const relogio = setInterval(() => { if (!p.isConnected) return parar(); mostrar(); }, 1000);
    const limite = setTimeout(() => { parar(); if (p.isConnected) aoDesistir(); }, 180000);
    function parar() { clearInterval(relogio); clearTimeout(limite); }
    return parar;
  }
  function criarResumo(u) {
    if (u.resumo) return;
    fecharSoltos();
    u.resumo = EL('axpt resumo', cabecalho(ICO.resumo, T('summary')) + '<p class="axpt-txt axpt-mudo">' + esc(T('summarizing')) + '<span class="axpt-pt"></span></p>');
    u.resumo.style.width = '260px'; u.resumo.style.maxHeight = '70vh'; u.resumo.style.overflow = 'auto';
    u.resumo.querySelector('.axpt-x').onclick = () => { u.resumo.remove(); u.resumo = null; if (u.pillResumo) u.pillResumo.classList.remove('on'); };
    document.body.appendChild(u.resumo);
    const alvo = u.resumo, t0 = Date.now();
    const parar = esperando(alvo.querySelector('.axpt-txt'), T('summarizing'), () => { alvo.querySelector('.axpt-txt').textContent = T('summaryTimeout'); });
    // o texto chega aos pedacos enquanto a IA escreve (porta "resumir" no background)
    let acumulado = '', terminou = false;
    const p = alvo.querySelector('.axpt-txt');
    const falhar = txt => { parar(); terminou = true; p.classList.add('axpt-mudo'); p.textContent = txt; };
    try {
      const porta = chrome.runtime.connect({ name: 'resumir' });
      porta.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (!terminou && alvo.isConnected) falhar(acumulado ? acumulado : T('summaryFail')); });
      porta.onMessage.addListener(m => {
        if (!alvo.isConnected) { terminou = true; try { porta.disconnect(); } catch (e) {} return; }
        if (m.delta) {
          if (!acumulado) { parar(); p.classList.remove('axpt-mudo'); LOG('summary started in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s'); }
          acumulado += m.delta; p.textContent = acumulado; posicionar();
        } else if (m.local) {
          // sem a chave da API nao ha resumo de verdade: so as frases principais traduzidas
          parar(); p.classList.remove('axpt-mudo');
          alvo.querySelector('.axpt-tag').textContent = T('keySentences');
          p.textContent = m.texto;
          p.insertAdjacentHTML('afterend', '<div class="axpt-f">' + esc(T('addKey')) + ' <span class="axpt-a" data-cfg="1">' + esc(T('settings')) + '</span></div>');
        } else if (m.erro) {
          falhar(''); p.innerHTML = esc(m.erro) + (m.semChave ? ' <span class="axpt-a" data-cfg="1">' + esc(T('settings')) + '</span>' : '');
        }
        if (m.fim && !acumulado) falhar(T('summaryFail'));
        if (m.fim || m.local || m.erro) { terminou = true; LOG('summary finished in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s'); try { porta.disconnect(); } catch (e) {} }
      });
      porta.postMessage({ texto: u.orig, citado: u.citado, status: u.status, links: u.links, imagens: u.imagens });
    } catch (e) { falhar(T('summaryFail')); }
    u.resumo.addEventListener('click', e => { if (e.target.dataset && e.target.dataset.cfg) chrome.runtime.sendMessage({ tipo: 'abrirOpcoes' }); });
    posicionar();
  }
  // o tweet citado costuma aparecer depois do principal: se chegou agora, atualiza (e mostra o botao de resumir se ficou longo)
  function atualizarCitado(span) {
    if (!ui || ui.span !== span) return;
    const t = lerBalao(span);
    if (t.citado.length <= (ui.citado || '').length + 20) return;
    LOG('quoted tweet captured: ' + contaPalavras(t.citado) + ' words');
    ui.citado = t.citado; if (!ui.quando) ui.quando = t.quando; if (!ui.autor) ui.autor = t.autor;
    if (precisaResumo(ui.orig, ui.citado)) botaoResumo(ui);
  }
  // links do balao: o do proprio tweet (para buscar o texto completo e o artigo) e os links que o tweet compartilha
  const RE_STATUS = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;
  let ultimoHover = null;
  // o balao do Axiom nem sempre tem o link do tweet, mas o card do Pulse que o abriu costuma ter:
  // sobe a partir do elemento sob o mouse ate achar um bloco com exatamente UM tweet linkado
  // card do Pulse (ou topo da pagina da moeda) que abriu o balao: o bloco com exatamente UM tweet linkado
  function cardDoHover() {
    // sobe enquanto continuar com 1 tweet so (o icone do X sozinho nao e o card inteiro); para antes de pegar outro card ou a lista
    let el = ultimoHover, achado = null;
    for (let i = 0; i < 14 && el && el !== document.body; i++, el = el.parentElement) {
      if (el.closest && el.closest('.axpt, .axpt-barra')) return null;
      const ids = new Set();
      for (const a of el.querySelectorAll('a[href*="/status/"]')) { const m = a.href.match(RE_STATUS); if (m) ids.add(m[2]); }
      if (ids.size > 1 || el.getBoundingClientRect().height > 400) break;
      if (ids.size === 1) achado = el;
    }
    return achado;
  }
  // nome e ticker da moeda que voce esta olhando: a IA explica por que ESSA moeda existe
  // (so na GMGN: no Axiom o ticker e o nome vem do React)
  function moedaDoCard() {
    try {
      const card = cardDoHover();
      let t = card ? String(card.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 220) : '';
      if (!t && /\/meme\//.test(location.pathname)) t = document.title.slice(0, 120);
      return t;
    } catch (e) { return ''; }
  }
  function linksDoBalao(principal) {
    let status = ''; const links = new Set();
    for (const a of areaDe(principal).querySelectorAll('a[href]')) {
      if (a.closest('.axpt-barra')) continue;
      const h = a.href, m = h.match(RE_STATUS);
      // a GMGN tem "x.com/i/status/ID" e "x.com/@autor/status/ID": prefere o que tem o autor
      if (m) { if (!status || /^i\//.test(status)) status = m[1] + '/' + m[2]; continue; }
      if (!/^https?:\/\//.test(h) || a.hostname === location.hostname) continue;              // links do proprio Axiom
      if (/^(www\.)?(x|twitter)\.com$/.test(a.hostname) && !/^\/i\/article\//.test(a.pathname)) continue;   // perfil, hashtag...
      links.add(h);
    }
    return { status, links: Array.from(links).slice(0, 3) };
  }
  // le o balao de novo na hora do clique: o tweet citado costuma carregar depois do principal
  function releCitado(u) {
    try {
      if (!u.span || !u.span.isConnected) return;
      const t = lerBalao(u.span);
      if (t.citado.length > (u.citado || '').length) u.citado = t.citado;
      if (t.autor) u.autor = t.autor; if (t.seguidores) u.seguidores = t.seguidores; if (!u.quando) u.quando = t.quando;
      if (t.imagens.length > (u.imagens || []).length) u.imagens = t.imagens;   // imagens costumam carregar depois do texto
      if (t.status) u.status = t.status; if (t.links.length) u.links = t.links;
      if (t.infos && (t.infos.e || !u.infos)) u.infos = t.infos;
      // sem o nome do autor nos dados, usa o @ que aparece no balao
      if (/^i\//.test(u.status || '') && u.autor) u.status = u.autor + u.status.slice(1);
    } catch (e) {}
  }
  // resumo so quando voce clica (cada resumo e uma chamada paga na API)
  function botaoResumo(u) {
    if (u.pillResumo) return;
    u.pillResumo = EL('axpt-pill', '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 5h12M4 10h12M4 15h7"/></svg>');
    u.pillResumo.title = T('btnSummarize');
    u.pillResumo.onclick = () => { if (u.resumo) return; releCitado(u); u.pillResumo.classList.add('on'); criarResumo(u); };
    u.barra.insertBefore(u.pillResumo, u.pill);
  }

  // ---- selos sem IA na barra: o que o balao ja mostra, de graca e na hora ----
  // endereco de contrato no texto: Solana (base58, com numero, maiuscula e minuscula) ou EVM (0x...)
  function contratoNoTexto(t) {
    for (const m of String(t).matchAll(/\b(?:0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/g))
      if (/^0x/.test(m[0]) || (/\d/.test(m[0]) && /[a-z]/.test(m[0]) && /[A-Z]/.test(m[0]))) return m[0];
    return '';
  }
  function selos(u, span) {
    const ca = contratoNoTexto(u.orig + '\n' + (u.citado || ''));
    if (ca) {
      const rotulo = 'CA';
      const c = EL('axpt-chip ca', rotulo);
      c.title = T('b_caDica') + '\n' + ca;
      c.onclick = () => { navigator.clipboard.writeText(ca).then(() => { c.textContent = '\u2713'; setTimeout(() => { c.textContent = rotulo; }, 1500); }).catch(() => {}); };
      u.barra.appendChild(c);
    }
  }

  function montarUI(span) {
    const lido = lerBalao(span), { orig, citado, quando, autor, seguidores, imagens } = lido;
    // varias moedas usam o mesmo tweet: a chave inclui a moeda (ticker e nome) para nao ficar o card da moeda anterior
    // (so recalcula quando o mouse veio de outro lugar: reavaliar roda a cada mudanca na pagina)
    const moeda = PELO_REACT ? lido.moeda : ui && ui.hoverEl === ultimoHover ? ui.moeda : ehTweetP(span) ? moedaDoCard() : '';
    const chave = hash(orig + '|' + moeda.split(/\s+/).slice(0, 2).join(' '));
    if (ui && ui.chave === chave) return;
    limparUI();
    ui = { chave, resumo: null, pill: null, check: null, rect: null, orig, citado, quando, autor, seguidores, imagens, status: lido.status, links: lido.links, infos: lido.infos };
    ui.popEl = janelaDe(span);
    ui.ehTweet = ehTweetP(span);
    ui.moeda = moeda; ui.hoverEl = ultimoHover;
    // pre-busca gratis do tweet completo: quando voce clicar no resumo ou na lupa, ele ja esta pronto
    if (ui.ehTweet && ui.status) {
      const st = /^i\//.test(ui.status) && autor ? autor + ui.status.slice(1) : ui.status;
      const alvo = ui;
      try { chrome.runtime.sendMessage({ tipo: 'preparar', status: st }, r => { void chrome.runtime.lastError; if (r && r.apagado && ui === alvo) seloApagado(alvo); }); } catch (e) {}
      // a pesquisa gratis (noticias, busca no X e na web) so comeca se o balao ficar aberto 0,7 s: passar o mouse rapido por varios tweets nao gasta os limites
      setTimeout(() => { if (ui === alvo) try { chrome.runtime.sendMessage({ tipo: 'pesquisar', status: st, texto: orig, citado, autor, links: lido.links }, () => void chrome.runtime.lastError); } catch (e) {} }, 700);
    }
    ui.barra = EL('axpt-barra');
    // o clique nos botoes nao pode chegar no balao (abriria o tweet)
    ['click', 'mousedown', 'pointerdown', 'mouseup'].forEach(t => ui.barra.addEventListener(t, e => e.stopPropagation()));

    // liga/desliga a traducao automatica
    ui.pillPT = EL('axpt-pill axpt-pt-bt', '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7 1.62-4.33L19.12 17h-3.24z"/></svg>');
    ui.pillPT.onclick = () => { const novo = !traduzLigado; aplicarTraducao(novo); try { chrome.storage.local.set({ traducaoLigada: novo }); } catch (e) {} };
    ui.barra.appendChild(ui.pillPT); atualizarBotaoPT();

    // botao de verificar (sempre que ha um tweet principal)
    ui.pill = EL('axpt-pill', '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4.5 4.5"/></svg>');
    ui.pill.title = T('btnAnalyze');
    ui.pill.onclick = () => verificar(ui);
    // Modo Turbo: parar o mouse na lupa ja comeca a analise (antes do clique). No clique a resposta ja esta pronta ou saindo.
    ui.pill.addEventListener('mouseenter', () => preAnalisar(ui));
    ui.barra.appendChild(ui.pill); ui.span = span;
    selos(ui, span);
    prenderBarra();

    // botao de resumir: tweet principal OU citado longo, ou tweet que so compartilha um link/artigo (o resumo le o link)
    if (precisaResumo(orig, citado) || ui.links.length || /x\.com\/i\/article\//.test(orig)) botaoResumo(ui);
    posicionar();
  }
  // tweet apagado do X: icone vermelho na barra (narrativa de tweet apagado costuma morrer)
  function seloApagado(u) {
    if (!u.barra || u.barra.querySelector('.axpt-apagado')) return;
    const c = EL('axpt-chip axpt-apagado', ICO.lixo);
    c.style.color = '#f87171'; c.title = T('deleted');
    u.barra.appendChild(c); posicionar();
  }
  // caixa "pergunte mais" (usada no card da lupa)
  function adicionarPerguntas(card, base, depois) {
    if (card.querySelector('.axpt-q')) return;
    const hist = [];
    const qa = EL('axpt-qa'); const linha = EL('axpt-q', '<input type="text" placeholder="' + esc(T('askTweet')) + '" spellcheck="false"><button title="' + esc(T('ask')) + '">' + ICO.enviar + '</button>');
    card.appendChild(qa); card.appendChild(linha);
    const inp = linha.querySelector('input'), bt = linha.querySelector('button');
    for (const ev of ['keydown', 'keyup', 'keypress']) inp.addEventListener(ev, e => e.stopPropagation());
    const enviar = () => {
      const pergunta = inp.value.trim(); if (!pergunta || bt.disabled) return;
      inp.value = ''; bt.disabled = true;
      const q = EL('q'); q.textContent = pergunta; const a = EL('a mudo axpt-mudo'); a.innerHTML = esc(T('thinking')) + '<span class="axpt-pt"></span>';
      qa.appendChild(q); qa.appendChild(a); card.scrollTop = card.scrollHeight; depois && depois();
      try {
        chrome.runtime.sendMessage(Object.assign({ tipo: 'perguntar', pergunta, historico: hist.slice() }, base), r => {
          bt.disabled = false; a.classList.remove('axpt-mudo');
          if (chrome.runtime.lastError || !r) a.textContent = T('noAnswer');
          else if (!r.ok) a.textContent = r.erro;
          else { a.textContent = r.texto; hist.push({ role: 'user', content: pergunta }, { role: 'assistant', content: r.texto }); }
          card.scrollTop = card.scrollHeight; depois && depois();
        });
      } catch (e) { bt.disabled = false; a.textContent = String(e.message || e); }
    };
    bt.onclick = enviar; inp.addEventListener('keydown', e => { if (e.key === 'Enter') enviar(); });
  }

  // ---- dados do React para a IA: engajamento, selo e idade da conta, site/Telegram/Discord da moeda ----
  const ano = d => { const m = String(d || '').match(/\b(20\d\d|19\d\d)\b/); return m ? m[1] : ''; };
  // dados do React em texto, so para a IA (pesa: famoso x anonimo, conta oficial x fake, tweet que ninguem viu)
  function infosParaIA(i) {
    if (!i) return '';
    const conta = (u, c) => c ? '@' + u + ': ' + [c.tipo ? 'verified ' + c.tipo : c.azul ? 'blue check' : 'no verification badge', ano(c.criada) ? 'account created ' + ano(c.criada) : '', c.bot ? 'marked as automated (bot)' : '', c.bio ? 'bio: ' + c.bio.slice(0, 200) : ''].filter(Boolean).join(', ') : '';
    const eng = e => e ? [e.lk != null ? e.lk + ' likes' : '', e.vw ? e.vw + ' views' : '', e.rt != null ? e.rt + ' retweets' : '', e.qt != null ? e.qt + ' quotes' : '', e.rp != null ? e.rp + ' replies' : ''].filter(Boolean).join(', ') : '';
    const l = [];
    if (i.u) { l.push('Tweet engagement: ' + eng(i.e)); l.push('Author ' + conta(i.u, i.c)); }
    if (i.outro) l.push('Quoted/replied author ' + conta(i.outro.u, i.outro.c) + (eng(i.outro.e) ? '; that tweet: ' + eng(i.outro.e) : ''));
    const so = i.sociais || {};
    const s = [so.site && 'website ' + so.site, so.tg && 'telegram ' + so.tg, so.dc && 'discord ' + so.dc].filter(Boolean);
    if (s.length) l.push('Coin links: ' + s.join(', '));
    return l.join('\n').slice(0, 1200);
  }
  // Modo Turbo: pede ao fundo para ja comecar a analise (so uma vez por tweet). O fundo guarda o resultado;
  // quando o clique abrir a porta "verificar", a mesma analise ja esta pronta ou em andamento.
  function preAnalisar(u) {
    if (!turbo || !u || u.check || u.turboFeito || !u.ehTweet || !u.status) return;
    u.turboFeito = true;
    try { chrome.runtime.sendMessage({ tipo: 'turbo', texto: u.orig, citado: u.citado, quando: u.quando, autor: u.autor, seguidores: u.seguidores, status: u.status, links: u.links, imagens: u.imagens, moeda: u.moeda, infos: infosParaIA(u.infos) }, () => void chrome.runtime.lastError); } catch (e) {}
  }

  function verificar(u) {
    if (u.check) return;
    fecharSoltos();
    releCitado(u);
    LOG('analyzing | tweet:', u.status || '(tweet link not found in the balloon or the card)', '| links:', u.links);
    u.pill.classList.add('on');
    const espera = T(u.links && u.links.length ? 'readingSources' : 'analyzing');
    const c = EL('axpt analise', cabecalho(ICO.lupa, T('narrative')) + '<p class="axpt-txt axpt-mudo">' + esc(espera) + '<span class="axpt-pt"></span></p>');
    let porta = null, terminou = false;
    const fechar = () => { c.remove(); u.check = null; u.pill.classList.remove('on'); terminou = true; try { porta && porta.disconnect(); } catch (e) {} posicionar(); };
    c.querySelector('.axpt-x').onclick = fechar;
    u.check = c; document.body.appendChild(c); posicionar();
    const t0 = Date.now();
    const parar = esperando(c.querySelector('.axpt-txt'), espera, () => { c.querySelector('.axpt-txt').textContent = T('analysisTimeout'); });
    // a resposta chega pela porta "verificar": { parcial } enquanto a IA escreve (veredito e manchete primeiro), depois { ok, resultado }
    let parcial = null, quadroP = false;
    const responder = r => {
        parar(); LOG('analysis answered in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s' + (r ? '' : ' | no answer'));
        if (!c.isConnected) return;
        // erro depois de um card parcial: volta ao card vazio para mostrar o erro
        if (parcial && r && !r.ok) { c.innerHTML = cabecalho(ICO.lupa, T('narrative')) + '<p class="axpt-txt axpt-mudo"></p>'; c.querySelector('.axpt-x').onclick = fechar; }
        const p = c.querySelector('.axpt-txt');
        if (!r) { if (parcial) desenhar(Object.assign({}, parcial, { incompleta: true })); else if (p) p.textContent = T('analysisFail'); return; }
        if (!r.ok) {
          if (r.semChave) {
            const q = encodeURIComponent(u.orig.replace(/https?:\/\/\S+/g, ' ').split(/\s+/).slice(0, 14).join(' '));
            p.classList.add('axpt-mudo');
            p.innerHTML = esc(T('needKey')) + ' <span class="axpt-a" data-cfg="1">' + esc(T('openSettings')) + '</span> ' + esc(T('or')) +
              ' <a class="axpt-a" target="_blank" rel="noopener" href="https://www.google.com/search?q=' + q + '&tbm=nws">' + esc(T('searchNews')) + '</a>.';
          } else p.innerHTML = esc(r.erro);
          return;
        }
        const x0 = r.resultado; desenhar(x0);
        posicionar();
    };
        // topicos: quem postou / o que diz / de onde vem o hype / e real? / riscos. O veredito fica em destaque no cabecalho.
        // emAndamento: card parcial do streaming (sem a caixa de perguntas, com os pontinhos de "escrevendo")
        const desenhar = (x, emAndamento) => {
        const v = VER[x.veredito] || VER.nao_confirmado;
        // sem fato pra checar (piada, meme, opiniao): so o resumo, sem selo nem "E verdade?"
        const semFato = x.veredito === 'nao_verificavel';
        const selo = semFato || !x.veredito ? '' : '<span class="axpt-vb" style="color:' + v[1] + ';background:' + v[1] + '1f">' + esc(T(v[0])) + '</span>';
        const fonte = f => /^https?:\/\//.test(f) ? '<a href="' + esc(f) + '" target="_blank" rel="noopener" title="' + esc(f) + '">' + esc(f.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')) + '</a>' : '<span>' + esc(f) + '</span>';
        c.style.setProperty('--ax-cor', v[1]);
        // curto: selo + Narrativa (a jogada) + Checagem (o que e real) + risco grave e fonte. **trecho** da IA vira negrito.
        const negrito = t => esc(t).replace(/\*\*([^*]{1,80})\*\*/g, '<b style="color:#fff">$1</b>').replace(/\*\*/g, '');
        const linha = (rot, t) => t ? '<p class="axpt-txt" style="color:#dfe0e4;line-height:1.5;margin:0 0 6px"><span style="color:#8a8d96;font-weight:600">' + esc(T(rot)) + (/\?$/.test(T(rot)) ? '' : ':') + '</span> ' + negrito(t) + '</p>' : '';
        // a checagem na web redesenha o card: guarda as perguntas ja feitas para nao sumirem
        const qaV = c.querySelector('.axpt-qa'), qV = c.querySelector('.axpt-q');
        // formato novo: manchete em destaque + topicos curtos (narrativa, checagem, moeda). Resposta antiga (sem manchete) cai no formato de antes
        const topico = (rot, t) => t ? '<div class="axpt-txt" style="display:flex;gap:6px;color:#dfe0e4;line-height:1.45;margin:0 0 5px"><span style="color:#8a8d96">•</span><span><span style="color:#8a8d96;font-weight:600">' + esc(T(rot)) + ':</span> ' + negrito(t) + '</span></div>' : '';
        const corpo = x.manchete
          ? '<p class="axpt-txt" style="color:#fff;font-weight:600;line-height:1.4;margin:0 0 8px">' + negrito(x.manchete) + '</p>' +
            topico('lb_story', x.narrativa) + (semFato ? '' : topico('lb_check2', x.checagem)) + topico('lb_coin', x.moeda)
          : linha('lb_narr', x.narrativa) + (semFato ? '' : linha('lb_check', x.checagem || x.resumo));
        c.innerHTML = cabecalho(ICO.lupa, T('narrative'), selo) + corpo +
          (x.risco ? '<div class="axpt-al" style="margin-top:8px"><div class="axpt-al-t" style="margin:0">' + ICO.alerta + negrito(x.risco) + '</div></div>' : '') +
          ((x.fontes || []).length ? '<div class="axpt-fs" style="margin-top:8px">' + x.fontes.map(fonte).join('') + '</div>' : '') +
          (x.incompleta ? '<div class="axpt-f">' + esc(T('incomplete')) + '</div>' : '') + (emAndamento ? '<p class="axpt-txt axpt-mudo" style="margin:0"><span class="axpt-pt"></span></p>' : '');
        c.querySelector('.axpt-x').onclick = fechar;
        c.style.maxHeight = '70vh'; c.style.overflow = 'auto';
        if (emAndamento) { posicionar(); return; }
        if (qaV && qV) { c.appendChild(qaV); c.appendChild(qV); }
        adicionarPerguntas(c, { modo: 'tweet', texto: u.orig, citado: u.citado, quando: u.quando, autor: u.autor, seguidores: u.seguidores, status: u.status, links: u.links, moeda: u.moeda, infos: infosParaIA(u.infos), resultado: x }, posicionar);
        // resposta rapida na tela; a checagem na web (se a IA pediu) chega depois e substitui o card
        posicionar();
        };
    try {
      porta = chrome.runtime.connect({ name: 'verificar' });
      porta.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (!terminou) { terminou = true; responder(null); } });
      porta.onMessage.addListener(m => {
        if (terminou) return;
        if (!c.isConnected) { terminou = true; try { porta.disconnect(); } catch (e) {} return; }
        if (m.parcial) {
          if (!parcial) { parar(); LOG('analysis started showing in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s'); }
          // um desenho por quadro de tela (os pedacos chegam varias vezes por segundo)
          parcial = m.parcial; if (!quadroP) { quadroP = true; requestAnimationFrame(() => { quadroP = false; if (!terminou && c.isConnected) desenhar(parcial, true); }); }
          return;
        }
        terminou = true; try { porta.disconnect(); } catch (e) {}
        responder(m);
      });
      porta.postMessage({ texto: u.orig, citado: u.citado, quando: u.quando, autor: u.autor, seguidores: u.seguidores, status: u.status, links: u.links, imagens: u.imagens, moeda: u.moeda, infos: infosParaIA(u.infos), turbo: turbo });
      c.addEventListener('click', e => { if (e.target.dataset && e.target.dataset.cfg) chrome.runtime.sendMessage({ tipo: 'abrirOpcoes' }); });
      // seguranca: nada chegou em 40 s (fundo travado ou dormiu) -> mostra o erro em vez de girar para sempre
      setTimeout(() => { if (!terminou && !parcial && c.isConnected) { terminou = true; try { porta.disconnect(); } catch (e) {} responder(null); } }, 40000);
    } catch (e) {
      // a extensao foi recarregada e esta aba ainda roda a versao antiga: sem conexao com o fundo
      terminou = true; parar();
      const p = c.querySelector('.axpt-txt'); if (p) p.textContent = T('reloadF5'); else c.insertAdjacentHTML('beforeend', '<p class="axpt-txt axpt-mudo">' + esc(T('reloadF5')) + '</p>');
      LOG('analysis: no connection to the extension (' + (e && e.message) + ')');
    }
  }

  function posicionar() {
    if (!ui || !ui.rect) return;
    const r = ui.rect, W = innerWidth, H = innerHeight, g = 8;
    prenderBarra();
    if (ui.resumo) {
      const w = 260, lado = ui.barra && !ui.barraEsq ? LARGURA_BARRA + VAO : 0;   // o resumo fica do lado da barra, sem cobrir
      let left = r.right + g + lado; if (left + w > W - g) left = Math.max(g, r.left - g - w - (ui.barraEsq ? LARGURA_BARRA + VAO : 0));
      ui.resumo.style.left = left + 'px'; ui.resumo.style.top = Math.max(g, r.top) + 'px';
    }
    const largura = Math.max(240, Math.min(r.width, 420));
    if (ui.check) {
      ui.check.style.width = largura + 'px';
      const h = ui.check.offsetHeight || 80;
      ui.check.style.left = Math.max(g, Math.min(r.left, W - largura - g)) + 'px';
      ui.check.style.top = Math.max(g, Math.min(r.bottom + 6 + (ui.barraEmbaixo ? ALTURA_BARRA + VAO : 0), H - h - g)) + 'px';
    }
  }

  // ================= varredura =================
  let agendado = false;
  // texto principal do cartao: o tweet (fonte de 18px); no cartao de perfil, a bio (p.break-words);
  // perfil sem bio: o proprio cartao (ainda da para analisar a conta: data de criacao, seguidores, nome)
  function principalDoCartao(cartao) {
    const tweet = Array.from(cartao.querySelectorAll(SEL)).find(s => s.textContent.trim());
    if (tweet) return tweet;
    const bio = cartao.querySelector('p[class*="break-words"]');
    const alvo = bio && bio.textContent.trim() ? bio : cartao;
    alvo.dataset.axPrincipal = '1';
    return alvo;
  }

  // ---- deteccao por eventos: nada fica checando em repeticao ----
  // O navegador avisa quando algo muda (MutationObserver/IntersectionObserver) e so entao a extensao trabalha:
  //  - na pagina: so olha os ELEMENTOS ADICIONADOS, e so reage se um deles for (ou tiver) um cartao de balao;
  //  - em cada balao: um observador proprio, que traduz o conteudo que chega depois (tweet citado, bio);
  //  - na janela do balao: avisa quando o Axiom mostra, esconde ou move o balao.
  // Precos e cronometros do Axiom mudam o tempo todo, mas nao sao cartoes: sao ignorados sem custo.
  const vistoEm = new WeakMap();   // balao -> quando apareceu pela primeira vez
  const conhecidos = new Set();    // texto principal dos baloes ja preparados (os que sairam da pagina sao descartados)
  const observados = new WeakSet();
  const observadoresDe = new Map();   // balao -> desliga os observadores dele quando sai da pagina

  // so se traduz o tweet, o tweet citado/respondido e a bio. Nome, @, data, localizacao e numeros ficam no original.
  // No Axiom o React diz quais sao esses textos; sem os dados (GMGN, perfil), so o texto principal do balao
  const normT = s => String(s).replace(/\s+/g, ' ').replace(/(\u2026|\.\.\.)$/, '').trim().toLowerCase();
  function textosPermitidos(principal) {
    if (!PELO_REACT || !ehTweetP(principal)) return null;
    const t = dadosDaPagina(principal).tweet; if (!t) return null;
    const lista = [];
    for (const x of [t, t.q, t.r]) if (x) { lista.push(x.x); if (x.c && x.c.bio) lista.push(x.c.bio); }
    return lista.map(normT).filter(Boolean);
  }
  function podeTraduzir(el, texto, principal, permitidos) {
    if (el && ((principal.contains(el) && !principal.matches(SEL_CARTAO)) || el.closest(SEL))) return true;   // perfil sem bio: o principal e o cartao inteiro
    const t = normT(texto);
    return !!permitidos && t.length >= 3 && permitidos.some(p => p.includes(t));
  }
  const RE_ARROBA = /^@[A-Za-z0-9_]{1,15}\b/;
  function ehNomePerfil(no, nomes) {
    const txt = no.nodeValue.trim();
    if (!txt || nomes.has(txt)) return !!txt;
    if (txt.length > 50) return false;
    let el = no.parentElement;
    for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
      if (el.matches(SEL) || el.matches(SEL_CARTAO)) return false;
      const resto = el.textContent.length - no.nodeValue.length;
      if (resto > 45) return false;   // subiu ate um bloco grande (bio, tweet): nao e a linha do nome
      // o nome vem ANTES do @ ("Nome @usuario"); texto depois do @ e tweet ou resposta ("@fulano obrigado")
      for (const a of el.querySelectorAll('a, span')) { const t = a.textContent.trim(); if (a !== no.parentElement && t.length <= 30 && RE_ARROBA.test(t) && (no.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) return true; }
    }
    return false;
  }
  // traduz o balao e passa a observar so ele
  function prepararBalao(principal) {
    const atual = textoComQuebras(principal);
    if (!atual) return;
    if (atual !== principal.dataset.axOrig && atual !== principal.dataset.axTrad) { principal.dataset.axOrig = atual; delete principal.dataset.axTrad; }
    const area = areaDe(principal), janela = janelaDe(principal);
    // paragrafos picotados (bio) primeiro, inteiros; depois os outros textos, pedaco por pedaco
    const ok = textosPermitidos(principal);
    blocosPicotados(area).filter(b => podeTraduzir(b, b.textContent, principal, ok)).forEach(traduzirBloco);
    traduzirNos(nosDeTexto(area).filter(n => podeTraduzir(n.parentElement, n.nodeValue, principal, ok) && !ehNomePerfil(n, new Set())));
    const tipo = area.matches(SEL_CARTAO) ? (ehTweetP(principal) ? 'tweet' : 'profile') : 'tweet (outside the card)';
    if (principal.dataset.axLog !== tipo) { principal.dataset.axLog = tipo; LOG('balloon found: ' + tipo + (janela ? '' : ' | no fixed window')); }
    const chaveB = janela || area; if (!vistoEm.has(chaveB)) vistoEm.set(chaveB, performance.now());
    conhecidos.add(principal);
    if (observados.has(area)) return;
    observados.add(area);
    // mudanca feita pela propria traducao nao conta (antes refazia o balao inteiro a cada pedaco traduzido)
    const o1 = new MutationObserver(rs => { if (rs.some(r => !(r.type === 'characterData' && feito.get(r.target) === r.target.nodeValue))) agendarBalao(area); });
    o1.observe(area, { childList: true, subtree: true, characterData: true });
    const o2 = janela ? new MutationObserver(() => agendarReavaliar()) : null;
    if (o2) o2.observe(janela, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    if (observadorVisivel) observadorVisivel.observe(area);
    observadoresDe.set(principal, () => { o1.disconnect(); if (o2) o2.disconnect(); if (observadorVisivel) observadorVisivel.unobserve(area); observados.delete(area); });
  }
  // some/aparece por CSS de um elemento acima da janela (display: none etc.)
  const observadorVisivel = typeof IntersectionObserver === 'function' ? new IntersectionObserver(() => agendarReavaliar()) : null;

  // junta tudo o que mudou no mesmo quadro de tela e processa uma vez
  const areasPendentes = new Set(), nosPendentes = new Set(); let quadro = false, reavaliarPendente = false, varrerDepois = false;
  function agendarBalao(area) { areasPendentes.add(area); agendarQuadro(); }
  function agendarReavaliar() { reavaliarPendente = true; agendarQuadro(); }
  function agendarQuadro() { if (!quadro) { quadro = true; requestAnimationFrame(processarQuadro); } }
  function processarQuadro() {
    quadro = false;
    try {
      // nos novos da pagina: olhados uma vez por quadro (o Axiom troca precos e timers dezenas de vezes por segundo)
      if (varrerDepois) { varrerDepois = false; varrerSeguro(); }
      const nos = [...nosPendentes]; nosPendentes.clear();
      for (const n of nos) if (n.isConnected) olharNo(n);
      const areas = [...areasPendentes]; areasPendentes.clear();
      for (const area of areas) {
        if (!area.isConnected) continue;
        const p = area.matches(SEL_CARTAO) ? principalDoCartao(area) : area.querySelector(SEL);
        if (p) prepararBalao(p);
      }
      if (areas.length || reavaliarPendente) { reavaliarPendente = false; reavaliar(areas.length > 0); }
    } catch (e) { LOG('detection error:', e && e.stack || e); }
  }

  // escolhe o balao visivel mais novo; posiciona os botoes ou agenda a limpeza
  function reavaliar(mudou) {
    let principal = null, maisNovo = -1;
    for (const p of conhecidos) {
      if (!p.isConnected) { conhecidos.delete(p); const d = observadoresDe.get(p); if (d) { d(); observadoresDe.delete(p); } continue; }
      const chaveB = janelaDe(p) || areaDe(p), t = vistoEm.get(chaveB) || 0;
      if (visivel(p) && t > maisNovo) { principal = p; maisNovo = t; }
    }
    if (principal) {
      clearTimeout(timerLimpar); timerLimpar = null;
      // montarUI nao refaz nada se for o mesmo tweet; refaz se o Axiom reaproveitou o balao para outro tweet
      // rolar a pagina so reposiciona; reler o balao (caro) so quando ele mudou ou e outro balao/moeda
      const outro = !ui || ui.span !== principal || ui.hoverEl !== ultimoHover || principal.dataset.axOrig !== ui.axOrig;
      if (outro) { montarUI(principal); if (ui) { ui.span = principal; ui.axOrig = principal.dataset.axOrig; } }
      if (ui && (outro || mudou)) atualizarCitado(principal);
      if (ui) { ui.rect = caixaDoBalao(principal); posicionar(); }
    } else if (ui) agendarLimpeza();
  }
  // o balao sumiu: os botoes/resumo/analise somem em 0,3 s (com o mouse em cima deles, esperam o mouse sair)
  let timerLimpar = null;
  function agendarLimpeza() {
    if (timerLimpar) return;
    timerLimpar = setTimeout(() => {
      timerLimpar = null;
      if (!ui || (ui.span.isConnected && visivel(ui.span))) return;
      if (!hover) limparUI();
    }, 300);
  }

  // varredura completa, so em ocasioes pontuais: ao carregar, ao religar a traducao e ao trocar de lingua
  function olharNo(n) {
    if (n.closest('.axpt, .axpt-barra')) return;
    if (n.matches(SEL_CARTAO)) { agendarBalao(n); return; }
    const dentro = n.closest(SEL_CARTAO); if (dentro) { if (!observados.has(dentro)) agendarBalao(dentro); return; }
    if (!n.firstElementChild && !n.matches(SEL)) return;   // folha solta (preco, timer): nada a procurar dentro
    for (const c of n.querySelectorAll(SEL_CARTAO)) agendarBalao(c);
    // reserva: tweet com a fonte de 18px fora do cartao (caso o Axiom mude a cor do cartao)
    const s = n.matches(SEL) ? n : n.querySelector(SEL);
    if (s && !s.closest(SEL_CARTAO) && s.textContent.trim().length >= 20) agendarBalao(areaDe(s));
  }
  function varrer() {
    agendado = false;
    for (const c of document.querySelectorAll(SEL_CARTAO)) agendarBalao(c);
    for (const s of document.querySelectorAll(SEL)) if (!s.closest(SEL_CARTAO) && s.textContent.trim().length >= 20) agendarBalao(areaDe(s));
    agendarReavaliar();
  }
  // erro na varredura aparece no Console com o prefixo da extensao (senao some no filtro)
  const varrerSeguro = () => { try { varrer(); } catch (e) { agendado = false; LOG('scan error:', e && e.stack || e); } };

  // os baloes so existem no Axiom e na GMGN: nos outros sites fica so o "Resumir esta pagina" (que roda quando voce clica)
  if (SITE) {
    new MutationObserver(registros => {
      for (const r of registros) {
        for (const n of r.addedNodes) if (n.nodeType === 1) nosPendentes.add(n);
        // o balao ativo saiu da pagina
        if (ui && r.removedNodes.length && !ui.span.isConnected) agendarReavaliar();
      }
      // aba em segundo plano nao desenha quadros: em vez de acumular milhares de nos, varre a pagina de uma vez depois
      if (nosPendentes.size > 3000) { nosPendentes.clear(); varrerDepois = true; }
      if (nosPendentes.size || varrerDepois) agendarQuadro();
    }).observe(document.body, { childList: true, subtree: true });
    // rolar a pagina ou mudar o tamanho da janela: reposiciona o resumo e a analise
    addEventListener('scroll', () => { if (ui) agendarReavaliar(); }, { passive: true, capture: true });
    addEventListener('resize', () => { if (ui) agendarReavaliar(); }, { passive: true });
    varrerSeguro();   // baloes que ja estavam na pagina quando a extensao carregou
  }

  document.addEventListener('mouseover', e => {
    const antes = hover;
    hover = !!(e.target.closest && e.target.closest('.axpt, .axpt-barra'));
    const saiuAgora = antes && !hover;
    // guarda onde o mouse estava antes de entrar no balao: e o card do Pulse que abriu o balao
    if (!hover && !(ui && ui.popEl && ui.popEl.contains(e.target)) && !(e.target.closest && e.target.closest((SITE || SITES.axiom).JANELA))) ultimoHover = e.target;
    // o mouse saiu dos botoes/resumo e o balao ja tinha sumido: some tambem
    // (no maximo 1 vez a cada 100 ms: checar visibilidade recalcula o estilo da pagina)
    if (!hover && ui) {
      const agora = performance.now();
      if (saiuAgora || agora - ultimaChecagem > 100) { ultimaChecagem = agora; if (!(ui.span.isConnected && visivel(ui.span))) agendarLimpeza(); }
    }
  }, true);
  let ultimaChecagem = 0;

  // ================= botao direito: explicar como a pagina funciona =================
  let balaoExp = null;
  // menus, rodape, aviso de cookies, barras laterais: nao explicam o projeto e comiam o espaco do texto
  const RUIDO = 'nav, footer, aside, [role="navigation"], [role="contentinfo"], [aria-modal="true"], [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [class*="newsletter" i]';
  // bruto = texto da pagina inteira, lido uma vez so (a auditoria usa o mesmo: innerText em pagina grande custa caro)
  // linhas com os numeros que importam (supply, taxa, contrato, lancamento, equipe...): sobrevivem ao corte de pagina longa
  const LINHA_CHAVE = /\b(supply|tax|taxes|fee|fees|contract|CA|mint|LP|burn|burned|launch|launches|stake|staking|team|dev|lock|locked|vesting|airdrop|presale|allocation|audit)\b|\d+(?:[.,]\d+)?\s?%/i;
  const CHAVE_PALAVRA = /\b(supply|tax|fee|fees|contract|CA|mint|LP|burn|launch|stake|staking|team|lock|vesting|allocation)\b/i;
  // texto maior que o limite: o comeco + as linhas-chave do texto INTEIRO (antes: slice as cegas, o fim de pagina longa sumia)
  function enxugar(t, max, inicio) {
    if (t.length <= max) return t;
    const ini = t.slice(0, inicio), chaves = [];
    for (const l of t.slice(inicio).split(/\n+/)) { const s = l.trim(); if (s.length > 8 && s.length < 400 && LINHA_CHAVE.test(s) && !ini.includes(s) && !chaves.includes(s)) chaves.push(s); }
    return (ini + '\n[...]\n' + chaves.join('\n')).slice(0, max);
  }
  // links que importam (comprar, grafico, redes, docs) vao com o endereco; o texto "BUY ON PUMP.FUN" sozinho nao diz para onde
  const LINK_UTIL = /pump\.fun\/coin\/|dexscreener\.com\/|birdeye\.so\/|\/\/(www\.)?(x|twitter)\.com\/\w|\/\/t\.me\/\w|discord\.(gg|com)\/\w|gitbook|\/\/docs?\.|whitepaper/i;
  function linksUteis() {
    const vistos = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.href; if (vistos.size >= 10) break;
      try { if (new URL(h).origin === location.origin) continue; } catch (e) { continue; }   // as paginas do proprio site ja sao lidas
      if (LINK_UTIL.test(h)) vistos.add(h.split('#')[0]);
    }
    return [...vistos];
  }
  // imagens grandes: alt ou nome do arquivo (site feito so de imagem: "tokenomics", "1B supply, 0/0 tax")
  function textoImagens() {
    const nomes = [];
    for (const i of document.images) {
      if ((i.width || i.naturalWidth) < 300) continue;
      let s = (i.alt || '').trim();
      if (!s) { try { s = decodeURIComponent((new URL(i.src).pathname.split('/').pop() || '').replace(/\.\w+$/, '')).replace(/[-_]+/g, ' ').trim(); } catch (e) {} }
      if (s.length > 2 && !/^[\da-f ]{12,}$/i.test(s) && !nomes.includes(s)) nomes.push(s);
      if (nomes.length >= 8) break;
    }
    return nomes;
  }
  // listas repetidas (trades, holders, chat, "recomendados"): num pai com 12+ filhos de mesma tag e classe ficam 4.
  // So subtrai o texto (nao mexe no DOM: nada pisca); filho com palavra-chave fica.
  function cortarListas(raiz, t) {
    let feitos = 0;
    for (const pai of raiz.querySelectorAll('tbody, table, ol, ul, div, section')) {
      if (pai.childElementCount < 12) continue;
      const conta = new Map();
      for (const f of pai.children) { const k = f.tagName + '.' + f.className; conta.set(k, (conta.get(k) || 0) + 1); }
      const [ass, n] = [...conta].sort((x, y) => y[1] - x[1])[0];
      if (n < 12 || /^(P|H\d|BR|PRE|BLOCKQUOTE|IMG|SCRIPT|STYLE)\./.test(ass)) continue;
      let iguais = 0, cursor = 0;
      for (const f of pai.children) {
        if (f.tagName + '.' + f.className !== ass || ++iguais <= 4) continue;
        const s = (f.innerText || '').trim(); if (s.length < 12 || CHAVE_PALAVRA.test(s)) continue;
        const i = t.indexOf(s, cursor); if (i < 0) continue;
        t = t.slice(0, i) + t.slice(i + s.length); cursor = i;
        if (++feitos >= 400) return t;
      }
    }
    return t;
  }
  function textoDaPagina() {
    const bruto = ((document.body && document.body.innerText) || '').trim();
    const sel = String(getSelection() || '').trim();
    if (sel.length > 300) return { texto: sel, bruto, selecao: true };
    let raiz = document.querySelector('main, article, [role="main"]'), t = raiz ? (raiz.innerText || '').trim() : '';
    if (t.length < 800) { raiz = document.body; t = bruto; }
    // tira o texto de cada bloco de ruido (no maximo 40; bloco curto demais pode repetir em outro lugar)
    if (raiz) for (const r of Array.from(raiz.querySelectorAll(RUIDO)).slice(0, 40)) {
      const s = (r.innerText || '').trim();
      if (s.length >= 25) { const i = t.indexOf(s); if (i >= 0) t = t.slice(0, i) + t.slice(i + s.length); }
    }
    if (raiz) t = cortarListas(raiz, t);
    t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const imgs = textoImagens(), links = linksUteis();
    const extra = (imgs.length ? '\nImagens: ' + imgs.join(' | ') : '') + (links.length ? '\nLinks: ' + links.join(' ') : '');
    // limite da pagina atual: 8000 letras, ja contando as linhas extras
    return { texto: (enxugar(t, 8000 - extra.length, 5000) + extra).trim(), base: t.length, bruto, selecao: false };
  }
  // impressao digital do texto (FNV-1a): a chave do cache muda quando o conteudo muda, nao so o tamanho
  const digital = t => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
  function fecharBalaoExp() { if (balaoExp) { balaoExp.host.remove(); balaoExp = null; } }
  function abrirBalaoExp() {
    fecharBalaoExp();
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = '<style>.b{position:relative;width:340px;max-height:72vh;overflow:auto;box-sizing:border-box;color:#e6e7ea;background:rgba(16,17,21,.97);border:1px solid #262830;border-top:2px solid #a78bfa;' +
      'border-radius:12px;padding:11px 14px 12px;font:13px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 14px 34px rgba(0,0,0,.5);backdrop-filter:blur(8px);animation:in .14s ease-out}' +
      '.b::-webkit-scrollbar{width:8px}.b::-webkit-scrollbar-thumb{background:#2a2c34;border-radius:8px}' +
      '@keyframes in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}' +
      '.t{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:#c9cbd1;margin:0 0 8px;padding-right:22px}.t svg{flex:none;color:#a78bfa}' +
      '.x{position:absolute;top:9px;right:9px;cursor:pointer;color:#7a7d86;font-size:16px;line-height:1;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:5px}.x:hover{color:#fff;background:#22242b}' +
      'p{margin:0 0 6px}p.hd{font-weight:600;line-height:1.45;margin:0 0 7px}ul{margin:0 0 4px;padding-left:16px}li{margin:0 0 3px;font-size:12.5px;line-height:1.45;color:#c4c6cc}li::marker{color:#5f626b}.m{color:#8a8d96}' +
      '.avs{margin-top:9px;padding-top:9px;border-top:1px solid #26282f}.av{display:flex;align-items:baseline;gap:7px;margin:0 0 5px;font-size:12px;line-height:1.4}.al{color:#8a8d96;white-space:nowrap}.ch{font-size:11.5px;font-weight:600;border-radius:5px;padding:0 6px;white-space:nowrap}.at{color:#c4c6cc}' +
      '.tec:empty{display:none}.tec{margin-top:9px;padding-top:9px;border-top:1px solid #26282f}.tt{font-size:11.5px;font-weight:600;color:#8a8d96;margin-bottom:4px}' +
      '.tl{list-style:none;padding:0;margin:0}.tl li{display:flex;gap:7px;font-size:12px;line-height:1.4;margin:0 0 3px}.tl li span{flex:none;width:9px;font-size:10px;line-height:1.7}' +
      '.qa{margin-top:6px;font-size:12.5px;line-height:1.5}.qa .q{font-weight:600;margin:10px 0 2px}.qa .a{white-space:pre-wrap;color:#c4c6cc}' +
      '.ql{display:none;position:relative;margin-top:11px}.ql.on{display:block}.ql input{box-sizing:border-box;width:100%;background:#0b0c0f;color:#e6e7ea;border:1px solid #2a2c33;border-radius:9px;padding:7px 38px 7px 10px;font:12.5px system-ui,-apple-system,"Segoe UI",sans-serif;outline:none}' +
      '.ql input:focus{border-color:#5465b8}.ql button{position:absolute;right:4px;top:50%;transform:translateY(-50%);width:27px;height:25px;display:flex;align-items:center;justify-content:center;background:#4f63d6;color:#fff;border:0;border-radius:7px;padding:0;cursor:pointer}' +
      '.ql button:hover{background:#5d72ea}.ql button:disabled{background:#2a2d35;color:#7a7d86;cursor:default}</style>' +
      '<div class="b"><span class="x" title="' + escH(T('close')) + '">\u00d7</span><div class="t"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 2.5h7l3.5 3.5v11.5h-10.5z"/><path d="M8 9.5h5M8 13h5"/></svg>' + escH(T('pageSummary')) + '</div><div id="c" class="m">' + escH(T('readingPage')) + '</div>' +
      '<div class="tec" id="tec"></div><div class="qa" id="qa"></div><div class="ql" id="ql"><input type="text" id="qi" placeholder="' + escH(T('askPage')) + '" spellcheck="false"><button id="qb" title="' + escH(T('ask')) + '"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h12M11 5l5 5-5 5"/></svg></button></div></div>';
    sh.querySelector('.x').onclick = fecharBalaoExp;
    document.documentElement.appendChild(host);
    balaoExp = { host, sh };
    return sh.getElementById('c');
  }
  const escH = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function mostrarExplicacao(el, texto) {
    const linhas = texto.split(/\n+/).map(l => l.trim()).filter(Boolean);
    let html = '', lista = [], aval = '';
    const fecha = () => { if (lista.length) { html += '<ul>' + lista.join('') + '</ul>'; lista = []; } };
    const COR = { sim: '#4ade80', talvez: '#fbbf24', nao: '#f87171', 'não': '#f87171', dificil: '#fbbf24', 'difícil': '#fbbf24' };
    // a IA escreve a palavra em portugues (sim, talvez, nao...); a tela mostra na lingua da interface
    const CHAVE = { sim: 'chip_sim', talvez: 'chip_talvez', nao: 'chip_nao', 'não': 'chip_nao', dificil: 'chip_dificil', 'difícil': 'chip_dificil', alta: 'chip_alta', media: 'chip_media', 'média': 'chip_media', baixa: 'chip_baixa' };
    const rotuloDe = p => CHAVE[p] ? T(CHAVE[p]) : (p ? p[0].toUpperCase() + p.slice(1) : '?');
    // "Cara de IA": alta e ruim (vermelho), baixa e bom (verde)
    const COR_IA = { alta: '#f87171', media: '#fbbf24', 'média': '#fbbf24', baixa: '#4ade80' };
    for (let l of linhas) {
      l = l.replace(/^\d+[.)]\s+/, '');   // sem numeracao de etapas
      let m;
      if ((m = /^cara de ia\s*:\s*(.*)$/i.exec(l))) {
        const palavra = (m[1].match(/^[A-Za-zÀ-ú]+/) || [''])[0].toLowerCase(), resto = m[1].slice(palavra.length).replace(/^[\s,.:;\-–]+/, '');
        const cor = COR_IA[palavra] || '#9ca3af', rotulo = rotuloDe(palavra);
        aval = '<div class="av"><span class="al">' + escH(T('looksAI')) + '</span><span class="ch" style="color:' + cor + ';background:' + cor + '1f">' + escH(rotulo) + '</span><span class="at">' + escH(resto) + '</span></div>' + aval;
      } else if ((m = /^(vale a pena|da pra fazer|dá pra fazer)\s*:\s*(.*)$/i.exec(l))) {
        const palavra = (m[2].match(/^[A-Za-zÀ-ú]+/) || [''])[0].toLowerCase(), resto = m[2].slice(palavra.length).replace(/^[\s,.:;\-]+/, '');
        const cor = COR[palavra] || '#9ca3af', rotulo = rotuloDe(palavra);
        aval += '<div class="av"><span class="al">' + escH(T(/vale/i.test(m[1]) ? 'worthIt' : 'doable')) + '</span><span class="ch" style="color:' + cor + ';background:' + cor + '1f">' + escH(rotulo) + '</span><span class="at">' + escH(resto) + '</span></div>';
      } else if (/^[-*•]\s+/.test(l)) lista.push('<li>' + escH(l.replace(/^[-*•]\s+/, '')) + '</li>');
      else if ((m = /^resumo\s*:\s*(.*)$/i.exec(l))) { fecha(); html += '<p class="hd">' + escH(m[1]) + '</p>'; }
      else { fecha(); html += '<p>' + escH(l) + '</p>'; }
    }
    fecha(); el.classList.remove('m'); el.innerHTML = html + (aval ? '<div class="avs">' + aval + '</div>' : '');
  }
  // ================= testes no site: sinais de "vibecode" e erros basicos =================
  // Roda no navegador, sem custo: olha o HTML, os links, as imagens e os recursos que falharam.
  // O resultado aparece no balao ("Testes no site") e vai junto para a IA dar o veredito "Cara de IA".
  const FRASES_IA = /\b(revolutioni[sz]\w*|unlock(?:ing)? the (?:power|potential|future)|seamless(?:ly)?|empower\w*|cutting[- ]edge|next[- ]gen(?:eration)?|game[- ]chang\w*|harness(?:ing)? the power|elevate your|in today'?s (?:fast[- ]paced|digital)|dive into|unleash\w*|supercharg\w*|effortless(?:ly)?|state[- ]of[- ]the[- ]art|the future of \w+ is here|revolucion\w*|de outro n[ií]vel|potencialize|sem esfor[cç]o)\b/gi;
  const PLACEHOLDERS = /lorem ipsum|your company|company name|your (?:project|token) name|example\.com|john doe|jane doe|acme (?:inc|corp)|\[insert[^\]]*\]|placeholder|todo:|sua empresa|nome do projeto/gi;
  const TITULO_PADRAO = /^(vite \+ react(?: \+ ts)?|react app|create next app|lovable(?: app)?|vite app|my v0 project|new project|untitled|document|home)$/i;
  const SITE_GERADO = /\.(lovable\.app|lovable\.dev|vercel\.app|netlify\.app|replit\.app|framer\.website|webflow\.io|wixsite\.com|carrd\.co|github\.io|pages\.dev)$/i;
  const SELO_IA = /made with (?:lovable|framer|bolt|v0|webflow|wix|carrd)|edit with lovable|built with (?:bolt|lovable|v0)|powered by (?:lovable|bolt)/i;

  function analisarSite(bruto) {
    const achados = [], add = (nivel, texto) => achados.push({ nivel, texto });
    const txt = bruto != null ? bruto : document.body ? document.body.innerText || '' : '';
    const ano = new Date().getFullYear();

    // ferramenta / hospedagem
    if (document.querySelector('[data-lov-id]')) add('alto', T('f_lovable'));
    else if (document.querySelector('[data-component-name], [data-v0-t]')) add('alto', T('f_marcas'));
    if (SELO_IA.test(txt)) add('alto', T('f_selo', txt.match(SELO_IA)[0]));
    const gen = document.querySelector('meta[name="generator"]');
    if (gen && gen.content) add('medio', T('f_gerador', gen.content.slice(0, 40)));
    if (SITE_GERADO.test(location.hostname)) add('medio', T('f_dominio', location.hostname.split('.').slice(-2).join('.')));

    // template sem terminar
    if (TITULO_PADRAO.test(document.title.trim())) add('alto', T('f_titulo', document.title.trim()));
    const ph = [...new Set((txt.match(PLACEHOLDERS) || []).map(s => s.toLowerCase()))];
    if (ph.length) add('alto', T('f_exemplo', ph.slice(0, 3).map(s => '"' + s + '"').join(', ')));
    const copy = (txt.match(/(?:©|copyright)\s*(\d{4})/i) || [])[1];
    if (copy && +copy < ano - 1) add('baixo', T('f_rodape', copy));

    // texto com cara de IA
    const frases = [...new Set((txt.match(FRASES_IA) || []).map(s => s.toLowerCase()))];
    if (frases.length >= 3) add(frases.length >= 6 ? 'alto' : 'medio', T('f_frases', frases.length, frases.slice(0, 3).map(s => '"' + s + '"').join(', ')));
    const emojis = [...document.querySelectorAll('h1, h2, h3, button')].reduce((n, h) => n + (h.textContent.match(/\p{Extended_Pictographic}/gu) || []).length, 0);
    if (emojis >= 4) add('baixo', T('f_emojis', emojis));

    // links e botoes que nao levam a lugar nenhum
    const links = [...document.querySelectorAll('a')];
    const mortos = links.filter(a => { const h = (a.getAttribute('href') || '').trim(); return !h || h === '#' || /^javascript:/i.test(h); });
    if (mortos.length) add(mortos.length >= 3 ? 'alto' : 'medio', T('f_mortos', mortos.length));
    const acao = mortos.filter(a => /buy|comprar|launch app|whitepaper|docs|chart|dexscreener|pump\.?fun|raydium|jupiter|telegram|twitter|discord/i.test(a.textContent + ' ' + (a.getAttribute('aria-label') || '')));
    if (acao.length) add('alto', T('f_botoes', [...new Set(acao.map(a => (a.textContent.trim() || a.getAttribute('aria-label') || '?').slice(0, 20)))].slice(0, 3).join(', ')));
    const redeVazia = links.filter(a => /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com|t\.me|discord\.gg|discord\.com|instagram\.com|tiktok\.com)\/?$/i.test(a.href));
    if (redeVazia.length) add('alto', T('f_social', redeVazia.length));
    const ancoras = links.filter(a => { const h = a.getAttribute('href') || ''; return /^#[\w-]+$/.test(h) && !document.getElementById(h.slice(1)); });
    if (ancoras.length) add('medio', T('f_ancoras', ancoras.length));

    // imagens, recursos e celular
    const imgs = [...document.images];
    const quebradas = imgs.filter(i => i.complete && i.getAttribute('src') && i.naturalWidth === 0);
    if (quebradas.length) add('alto', T('f_imagens', quebradas.length));
    const falhas = performance.getEntriesByType('resource').filter(e => e.responseStatus >= 400);
    if (falhas.length) add(falhas.length >= 3 ? 'alto' : 'medio', T('f_arquivos', falhas.length, [...new Set(falhas.map(e => e.responseStatus))].join(', ')));
    if (!document.querySelector('meta[name="viewport"]')) add('medio', T('f_celular'));
    if (!document.querySelector('link[rel~="icon"]')) add('baixo', T('f_favicon'));
    if (!document.querySelector('meta[name="description"]')) add('baixo', T('f_descricao'));
    // seguranca e o basico de um site de verdade (ideias da auditoria da squirrelscan que da para checar no navegador)
    const semHttps = performance.getEntriesByType('resource').filter(e => /^http:\/\//i.test(e.name)).length;
    if (semHttps) add('medio', T('f_misto', semHttps));
    if (!links.some(a => /terms|privacy|termos|privacidade|legal|tos\b/i.test(a.textContent + ' ' + a.getAttribute('href')))) add('baixo', T('f_semTermos'));
    if (!document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')) add('baixo', T('f_semOg'));

    // memecoin: endereco de contrato
    // so conta fora de listas e tabelas (holders, trades): antes toda pagina de moeda dava "31 enderecos";
    // em pump.fun / dexscreener o contrato esta no endereco da pagina
    const acharCAs = s => [...new Set(s.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) || [])].filter(c => /\d/.test(c) && /[a-z]/.test(c) && /[A-Z]/.test(c));
    const listas = [...document.querySelectorAll('ol, ul, table')].filter(e => !e.parentElement.closest('ol, ul, table')).map(e => e.textContent).join(' ');
    const naLista = acharCAs(listas), vezes = (s, c) => s.split(c).length - 1;
    let cas = acharCAs(txt).filter(c => vezes(txt, c) > vezes(listas, c));   // aparece tambem fora das listas
    if (!cas.length && naLista.length <= 2) cas = naLista;   // o contrato real pode estar numa lista de tokenomics
    if (/(^|\.)(pump\.fun|dexscreener\.com)$/i.test(location.hostname)) {}
    else if (cas.length > 1) add('alto', T('f_contratos', cas.length));
    else if (cas.length === 1) add('info', T('f_contrato', cas[0].slice(0, 6) + '…' + cas[0].slice(-4)));
    else if (/\b(token|coin|memecoin|\$[A-Z]{2,10})\b/.test(txt) && /\b(buy|comprar|launch|presale|pr[eé]-venda)\b/i.test(txt)) add('medio', T('f_semContrato'));

    if (!achados.some(a => a.nivel !== 'info')) add('ok', T('f_ok'));
    return achados;
  }
  // Chaves secretas no codigo do site (comum em site vibecodado: a IA coloca a chave direto no front-end).
  // Olha os scripts da pagina e ate 4 arquivos de script do proprio site. So aponta o tipo, nunca mostra a chave.
  const SEGREDOS = [
    ['Anthropic', /\bsk-ant-[A-Za-z0-9_-]{30,}/], ['OpenAI', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/], ['AWS', /\bAKIA[0-9A-Z]{16}\b/],
    ['Stripe', /\bsk_live_[0-9a-zA-Z]{20,}/], ['GitHub', /\bghp_[A-Za-z0-9]{36}\b/], ['Telegram bot', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ];
  // chave privada de carteira Solana: base58 longo ou lista de 64 numeros, perto de "secret/private key" ou fromSecretKey
  const CHAVE_PRIVADA = /(?:secret|private)[_\s-]?key["'\s:=]{1,6}["'`]?[1-9A-HJ-NP-Za-km-z]{86,88}|fromSecretKey\(\s*(?:new Uint8Array\(\s*)?\[(?:\s*\d{1,3}\s*,){63}/i;
  async function procurarSegredos() {
    const textos = [...document.scripts].filter(s => !s.src).map(s => s.textContent);
    const arquivos = [...document.scripts].map(s => s.src).filter(src => { try { return new URL(src).origin === location.origin; } catch (e) { return false; } }).slice(0, 4);
    // os arquivos juntos (antes um por vez: ate 4 x 5 s); quase sempre ja estao no cache do navegador
    await Promise.all(arquivos.map(async src => {
      try { const r = await fetch(src, { signal: AbortSignal.timeout(4000) }); if (r.ok) textos.push((await r.text()).slice(0, 3e6)); } catch (e) {}
    }));
    const codigo = textos.join('\n'), achados = [];
    const tipos = SEGREDOS.filter(([, re]) => re.test(codigo)).map(([nome]) => nome);
    if (tipos.length) achados.push({ nivel: 'alto', texto: T('f_segredo', tipos.join(', ')) });
    if (CHAVE_PRIVADA.test(codigo)) achados.push({ nivel: 'alto', texto: T('f_chavePrivada') });
    return achados;
  }

  // Le o site inteiro: a pagina atual + ate 7 paginas internas importantes (docs, how it works, tokenomics, fees...).
  // Site feito so com JavaScript (a pagina vem vazia sem rodar o script) nao tem o que ler nas outras paginas: fica so a atual.
  // Documentacao em outro endereco (GitBook, docs.site.com) vai como link para o Claude abrir.
  const IMPORTANTE = /doc|how|about|faq|token|whitepaper|paper|fee|reward|launch|guide|work|earn|stak|airdrop|roadmap|learn|mechanic|economics/i;
  // paginas legais, de conta e de outros autores nao explicam o projeto (eram ate 75% do texto enviado)
  const LEGAL = /\/(privacy|terms|tos|cookies?|legal|careers|jobs|press|help|support|status|log-?in|sign-?in|sign-?up|register|profile|account|tag)\b|\/@/i;
  // plataformas: as outras paginas do site sao de outros projetos/autores, nao le
  const PLATAFORMA = /(^|\.)(medium\.com|substack\.com|mirror\.xyz|pump\.fun|dexscreener\.com|x\.com|twitter\.com|github\.com)$/i;
  // subpagina: o comeco + as frases com numeros-chave (antes 4000 letras fixas, quase tudo texto generico)
  const enxugarSub = t => { const ini = t.slice(0, 800); return (ini + ' ' + t.slice(800).split(/(?<=[.!?])\s+/).filter(f => LINHA_CHAVE.test(f) && f.length < 400).join(' ').slice(0, 1200)).trim(); };
  // prazo (ms): o que nao chegou ate la fica de fora (antes esperava ate 5 s pela pagina mais lenta)
  async function lerSiteInteiro(paginaAtual, progresso, prazo) {
    const paginas = [{ url: location.href, titulo: document.title, texto: paginaAtual.slice(0, 8000) }];
    const vistos = new Set([location.href.split('#')[0]]), internos = [], externos = [];
    for (const a of document.querySelectorAll('a[href]')) {
      let u; try { u = new URL(a.href); } catch (e) { continue; }
      const h = u.href.split('#')[0];
      if (vistos.has(h) || !/^https?:$/.test(u.protocol)) continue;
      vistos.add(h);
      const rotulo = a.textContent + ' ' + u.hostname + u.pathname;
      if (u.origin === location.origin) { if (!LEGAL.test(u.pathname) && !a.closest('footer')) internos.push({ h, pontos: IMPORTANTE.test(rotulo) ? 2 : u.pathname.split('/').filter(Boolean).length <= 1 ? 1 : 0 }); }
      else if (externos.length < 3 && IMPORTANTE.test(rotulo) && /docs?\.|gitbook|notion\.site|medium\.com|mirror\.xyz|whitepaper|paper/i.test(u.href)) externos.push(h);
    }
    const escolhidas = PLATAFORMA.test(location.hostname) ? [] : internos.sort((x, y) => y.pontos - x.pontos).slice(0, 7).map(i => i.h);
    let lidas = 0; progresso(1, escolhidas.length + 1);
    const ctrl = new AbortController(), resultados = [], docsLidos = [];
    const ler = async (h, max) => {
      const r = await fetch(h, { signal: ctrl.signal });
      if (!r.ok || !/html/i.test(r.headers.get('content-type') || '')) return null;
      const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
      doc.querySelectorAll('script, style, noscript, nav, footer, aside, svg, template, ' + RUIDO).forEach(e => e.remove());
      const texto = (doc.body ? doc.body.textContent : '').replace(/\s+/g, ' ').trim();
      return texto.length >= 200 ? { url: h, titulo: doc.title, texto: max ? texto.slice(0, max) : enxugarSub(texto) } : null;
    };
    const tarefas = escolhidas.map(async h => {
      try { const p = await ler(h, 0); if (p) resultados.push(p); } catch (e) {}
      finally { progresso(2 + lidas++, escolhidas.length + 1); }
    }).concat(externos.map(async h => {
      // documentacao em outro endereco: a extensao tenta ler (so funciona quando o site deixa, CORS); se ler, a IA nao precisa abrir
      try { const p = await ler(h, 5000); if (p) { resultados.push(p); docsLidos.push(h); } } catch (e) {}
    }));
    await Promise.race([Promise.all(tarefas), new Promise(ok => setTimeout(ok, prazo))]);
    ctrl.abort();
    // ordem de importancia (documentacao primeiro), nao de chegada: o corte de 24 mil letras tira o menos importante
    const ordem = h => { const i = externos.indexOf(h); return i >= 0 ? i - 10 : escolhidas.indexOf(h); };
    resultados.sort((x, y) => ordem(x.url) - ordem(y.url));
    // a mesma pagina repetida (site que devolve sempre o mesmo conteudo) entra uma vez so
    const unicas = [], comecos = new Set([paginas[0].texto.replace(/\s+/g, ' ').slice(0, 300)]);
    for (const p of resultados) if (p && !comecos.has(p.texto.slice(0, 300))) { comecos.add(p.texto.slice(0, 300)); unicas.push(p); }
    return { paginas: paginas.concat(unicas), externos: externos.filter(h => !docsLidos.includes(h)) };
  }

  // testa ate 8 links internos (mesmo site) e conta os que dao erro 404/500
  async function testarLinksInternos() {
    const urls = [...new Set([...document.querySelectorAll('a[href]')].map(a => a.href.split('#')[0])
      .filter(h => { try { const u = new URL(h); return u.origin === location.origin && h !== location.href.split('#')[0]; } catch (e) { return false; } }))].slice(0, 8);
    if (!urls.length) return null;
    const res = await Promise.all(urls.map(u => {
      const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 4000);
      return fetch(u, { method: 'HEAD', signal: ctrl.signal }).then(r => r.status, () => 0).finally(() => clearTimeout(t));
    }));
    const ruins = res.filter(s => s >= 400 || s === 0).length;
    return ruins ? { nivel: ruins >= 2 ? 'alto' : 'medio', texto: T('f_linksRuins', ruins, urls.length) }
      : { nivel: 'ok', texto: T('f_linksOk', urls.length) };
  }
  const ICONE = { alto: ['●', '#f87171'], medio: ['●', '#fbbf24'], baixo: ['●', '#8a8d96'], info: ['●', '#8fa5ff'], ok: ['✓', '#4ade80'] };
  function mostrarTestes(achados, testando) {
    const sh = balaoExp && balaoExp.sh, box = sh && sh.getElementById('tec'); if (!box) return;
    const ordem = { alto: 0, medio: 1, info: 2, baixo: 3, ok: 4 };
    box.innerHTML = '<div class="tt">' + escH(T('siteChecks')) + '</div><ul class="tl">' + achados.slice().sort((a, b) => ordem[a.nivel] - ordem[b.nivel]).slice(0, 8)
      .map(a => '<li><span style="color:' + ICONE[a.nivel][1] + '">' + ICONE[a.nivel][0] + '</span>' + escH(a.texto) + '</li>').join('') +
      (testando ? '<li class="m"><span>…</span>' + escH(T('testingLinks')) + '</li>' : '') + '</ul>';
  }

  function ligarPerguntasPagina(el, base) {
    const sh = balaoExp && balaoExp.sh; if (!sh) return;
    const ql = sh.getElementById('ql'), inp = sh.getElementById('qi'), bt = sh.getElementById('qb'), qa = sh.getElementById('qa');
    if (!ql || ql.classList.contains('on')) return;
    ql.classList.add('on');
    for (const ev of ['keydown', 'keyup', 'keypress']) inp.addEventListener(ev, e => e.stopPropagation());
    const hist = [];
    const enviar = () => {
      const pergunta = inp.value.trim(); if (!pergunta || bt.disabled) return;
      inp.value = ''; bt.disabled = true;
      const q = document.createElement('div'); q.className = 'q'; q.textContent = pergunta;
      const a = document.createElement('div'); a.className = 'a m'; a.textContent = T('thinking') + '…';
      qa.appendChild(q); qa.appendChild(a); a.scrollIntoView({ block: 'nearest' });
      try {
        chrome.runtime.sendMessage(Object.assign({ tipo: 'perguntar', modo: 'pagina', pergunta, historico: hist.slice() }, base), r => {
          bt.disabled = false; a.classList.remove('m');
          if (chrome.runtime.lastError || !r) a.textContent = T('noAnswer');
          else if (!r.ok) a.textContent = r.erro;
          else { a.textContent = r.texto; hist.push({ role: 'user', content: pergunta }, { role: 'assistant', content: r.texto }); }
          a.scrollIntoView({ block: 'nearest' });
        });
      } catch (e) { bt.disabled = false; a.textContent = String(e.message || e); }
    };
    bt.onclick = enviar; inp.addEventListener('keydown', e => { if (e.key === 'Enter') enviar(); });
  }
  // resolve quando a pagina tem texto e fica 300 ms sem mudar, ou no limite
  const esperarConteudo = limite => new Promise(ok => {
    let t = null; const fim = () => { o.disconnect(); clearTimeout(t); clearTimeout(teto); ok(); };
    const o = new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => { if ((document.body.innerText || '').trim().length >= 80) fim(); }, 300); });
    o.observe(document.body, { childList: true, subtree: true, characterData: true });
    const teto = setTimeout(fim, limite);
  });
  chrome.runtime.onMessage.addListener((msg, _s, responder) => {
    if (!msg || msg.tipo !== 'explicarPagina' || window !== window.top) return;
    responder({ ok: true });   // o background sabe que o script ja esta na pagina e nao injeta de novo
    const el = abrirBalaoExp();
    (async () => {
      let { texto, bruto, selecao } = textoDaPagina();
      // SPA (React/Vite): o conteudo ainda nao apareceu; espera ate 2 s o DOM crescer e parar de mudar
      if (texto.length < 80 && document.body) { await esperarConteudo(2000); ({ texto, bruto, selecao } = textoDaPagina()); }
      if (texto.length < 80) { el.textContent = T('notEnoughText'); return; }
      let acumulado = '', recebeu = false, textoSite = texto.slice(0, 24000), esperaCache = null;
      const prazo = Date.now() + 2500;   // leitura do site + auditoria: no maximo 2,5 s desde o clique, depois o pedido sai com o que chegou
      const chave = location.href.split('#')[0] + '|' + texto.length + '|' + digital(texto);
      // 0) porta aberta ja no inicio: o background confere o cache enquanto a auditoria comeca
      let porta;
      try { porta = chrome.runtime.connect({ name: 'explicar' }); } catch (e) { el.textContent = T('pageFail') + (e.message || e); return; }
      const cache = new Promise(ok => { esperaCache = ok; setTimeout(() => ok(null), 400); });
      const espera = setTimeout(() => { if (!recebeu && el.isConnected) el.textContent = T('extNoResponse'); }, 15000);
      porta.onMessage.addListener(m => {
        if (m.cache != null || m.semCache) { if (esperaCache) esperaCache(m.cache || null); return; }
        if (!el.isConnected) return;
        recebeu = true; clearTimeout(espera);
        if (m.erro) { el.classList.add('m'); el.textContent = m.erro + (m.semChave ? T('clickIcon') : ''); return; }
        if (m.delta) { acumulado += m.delta; mostrarExplicacao(el, acumulado); }
        if (m.fim) ligarPerguntasPagina(el, { titulo: document.title, texto: textoSite, resposta: acumulado });
      });
      porta.postMessage({ consulta: true, chave });
      // 1) auditoria: os testes rapidos aparecem na hora; chaves secretas e links internos chegam logo depois
      let achados = [];
      const juntar = novos => { if (novos.length) achados = achados.filter(a => a.nivel !== 'ok' || novos.every(n => n.nivel === 'ok')).concat(novos); };
      const auditoria = Promise.all([
        procurarSegredos().catch(() => []),
        testarLinksInternos().then(r => (r ? [r] : [])).catch(() => []),
      ]).then(([segredos, links]) => { juntar(segredos); juntar(links); mostrarTestes(achados, false); });
      try { achados = analisarSite(bruto); } catch (e) { LOG('site check error:', e.message); }
      mostrarTestes(achados, true);
      // ja resumido (mesmo endereco e mesmo texto): mostra na hora, sem ler o site de novo
      const salvo = await cache;
      if (salvo) { recebeu = true; clearTimeout(espera); acumulado = salvo; mostrarExplicacao(el, salvo); ligarPerguntasPagina(el, { titulo: document.title, texto: textoSite, resposta: salvo }); return; }
      // 2) le o site inteiro (pagina atual + paginas internas importantes), no maximo 2,5 s.
      //    Texto selecionado: o pedido e sobre ele, nao precisa ler o resto do site
      const site = selecao ? { paginas: [{ url: location.href, titulo: document.title, texto: texto.slice(0, 24000) }], externos: [] }
        : await lerSiteInteiro(texto, (n, total) => { if (el.isConnected && !acumulado) el.textContent = T('readingSite', n, total); }, Math.max(0, prazo - Date.now()));
      await Promise.race([auditoria, new Promise(r => setTimeout(r, Math.max(0, prazo - Date.now())))]);   // a auditoria rodou junto com a leitura, mesmo prazo
      const tecnico = achados.map(a => '- [' + a.nivel + '] ' + a.texto).join('\n');
      textoSite = site.paginas.map(p => '### ' + (p.titulo || '') + ' (' + p.url + ')\n' + p.texto).join('\n\n').slice(0, 24000);
      LOG('site read: ' + site.paginas.length + ' page(s)' + (site.externos.length ? ' + ' + site.externos.length + ' external doc link(s)' : ''));
      if (el.isConnected) el.textContent = T('summarizingSite');
      // 3) resumo curto com a mecanica concreta + "cara de IA"
      try { porta.postMessage({ chave, url: location.href, titulo: document.title, texto: textoSite, tecnico, externos: site.externos }); }
      catch (e) { el.textContent = T('pageFail') + (e.message || e); }
    })();
  });
})();
