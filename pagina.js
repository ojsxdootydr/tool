// Roda DENTRO da pagina do Axiom (so leitura). O tweet e a moeda do balao ficam nos dados do React; este script le e devolve ao content.js.
// Comunicacao: o content.js marca o elemento com data-ax-alvo-dados e dispara "axpt-pedir-dados"; a resposta volta em data-ax-dados.
(() => {
  if (window.__axptPagina) return;
  window.__axptPagina = true;
  const RE = /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;
  const ehId = v => /^\d{15,20}$/.test(String(v || ''));

  function fiberDe(el) {
    const k = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    return k ? el[k] : null;
  }
  // ---- dados completos do tweet e da moeda, guardados pelo Axiom nos dados do React ----
  // Tweet: autor, texto inteiro, tweet citado/respondido (com o autor de cada um), links e imagens.
  // Moeda: so ticker e nome. Nada de carteira, holders, saldo ou fees.
  const ehTweet = o => o && typeof o === 'object' && ehId(o.id) && typeof o.text === 'string' && o.userInfo && typeof o.userInfo === 'object';
  function textoLimpo(o) {
    let t = String(o.text || '');
    // troca o t.co pelo link de verdade; o t.co que sobra e da foto/video
    for (const u of (o.entities && Array.isArray(o.entities.urls) ? o.entities.urls : []).slice(0, 10))
      if (u && u.url && u.expandedUrl) t = t.split(u.url).join(u.expandedUrl);
    return t.replace(/\s*https:\/\/t\.co\/\w+/g, '').trim().slice(0, 4000);
  }
  function compactar(o, prof) {
    const u = o.userInfo || {};
    const midia = o.extendedEntities && Array.isArray(o.extendedEntities.media) ? o.extendedEntities.media : [];
    const r = {
      id: String(o.id), u: String(u.userName || ''), n: String(u.name || '').slice(0, 80),
      f: typeof u.followers === 'number' ? u.followers : null, x: textoLimpo(o), d: String(o.createdAt || ''),
      l: (o.entities && Array.isArray(o.entities.urls) ? o.entities.urls : []).map(e => e && e.expandedUrl).filter(v => typeof v === 'string').slice(0, 5),
      m: midia.map(e => e && e.mediaUrlHttps).filter(v => typeof v === 'string').slice(0, 4),
      // engajamento e dados publicos da conta (selo, bio, idade, bot)
      e: { lk: num(o.likeCount), vw: num(o.viewCount), rt: num(o.retweetCount), qt: num(o.quoteCount), rp: num(o.replyCount) },
      c: { azul: u.isBlueVerified === true, tipo: typeof u.verifiedType === 'string' ? u.verifiedType.slice(0, 20) : '', bio: String(u.description || '').slice(0, 500),
        criada: String(u.createdAt || ''), bot: u.isAutomated === true }
    };
    if (prof < 2) {
      if (o.isQuote && ehTweet(o.quotedTweet)) r.q = compactar(o.quotedTweet, prof + 1);
      if (o.isReply && ehTweet(o.replyTweet)) r.r = compactar(o.replyTweet, prof + 1);
    }
    return r;
  }
  const num = v => typeof v === 'number' && isFinite(v) ? v : null;
  const linkOk = v => typeof v === 'string' && /^https?:\/\/[^\s"<>]+$/.test(v) ? v.slice(0, 200) : '';
  const ehSociais = o => o && typeof o === 'object' && 'website' in o && ('telegram' in o || 'discord' in o);
  const ehMoeda = o => o && typeof o === 'object' && typeof o.tokenTicker === 'string' && o.tokenTicker && typeof o.tokenName === 'string';
  function dadosDe(el) {
    let tweet = null, moeda = null, sociais = null, f = fiberDe(el);
    for (let i = 0; i < 80 && f && !(tweet && moeda && sociais); i++, f = f.return) {
      const p = f.memoizedProps;
      if (!p || typeof p !== 'object') continue;
      // o primeiro tweet achado pode ser o citado desenhado dentro do principal: um tweet de fora que o contem e o principal
      for (const k of ['tweetData', 'cachedTweetData']) {
        const t = p[k]; if (!ehTweet(t)) continue;
        if (!tweet) tweet = t;
        else if (t !== tweet && ((t.quotedTweet && t.quotedTweet.id === tweet.id) || (t.replyTweet && t.replyTweet.id === tweet.id))) tweet = t;
      }
      for (const c of [p, p.pair, p.token, p.data]) {
        if (!moeda && ehMoeda(c)) moeda = c;
        if (!sociais && ehSociais(c)) sociais = c;
      }
    }
    const r = {};
    // retweet: o tweet que importa e o original (texto, artigo, autor); quem repostou vai junto
    if (tweet && tweet.isRetweet) {
      const k = Object.keys(tweet).find(k => /retweet/i.test(k) && ehTweet(tweet[k]));
      if (k) {
        const u = tweet.userInfo || {}, rt = tweet;
        tweet = tweet[k];
        r.tweet = compactar(tweet, 0);
        r.tweet.rtPor = { u: String(u.userName || ''), n: String(u.name || '').slice(0, 80), f: num(u.followers), id: String(rt.id) };
      }
    }
    if (tweet && !r.tweet) r.tweet = compactar(tweet, 0);
    if (moeda) {
      r.moeda = (String(moeda.tokenTicker).slice(0, 30) + ' ' + String(moeda.tokenName).slice(0, 80)).trim();
      const m = typeof moeda.twitter === 'string' && moeda.twitter.match(RE);   // link do tweet da moeda (reserva, se o tweet nao carregou)
      if (m) r.statusMoeda = m[1] + '/' + m[2];
    }
    // site, Telegram e Discord da moeda (so os links)
    if (sociais) {
      const s = { site: linkOk(sociais.website), tg: linkOk(sociais.telegram), dc: linkOk(sociais.discord) };
      if (s.site || s.tg || s.dc) r.sociais = s;
    }
    return r;
  }
  window.addEventListener('axpt-pedir-dados', e => {
    const alvo = e.target && e.target.nodeType === 1 && e.target.hasAttribute('data-ax-alvo-dados') ? [e.target] : document.querySelectorAll('[data-ax-alvo-dados]');
    for (const el of alvo) {
      try { const r = dadosDe(el); if (r.tweet || r.moeda) el.setAttribute('data-ax-dados', JSON.stringify(r)); } catch (e) {}
    }
  });

})();
