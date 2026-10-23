// Testes rapidos, sem navegador. Rode na pasta da extensao: node testes/testar.js
// Conferem as partes que nao dependem do Chrome: termos protegidos na traducao, textos da interface e o manifest.
const fs = require('fs'), path = require('path'), assert = require('assert');
const raiz = path.join(__dirname, '..');
const ler = f => fs.readFileSync(path.join(raiz, f), 'utf8');
let ok = 0, falhou = 0;
function teste(nome, fn) {
  try { fn(); ok++; console.log('ok   ' + nome); }
  catch (e) { falhou++; console.log('FALHOU ' + nome + '\n     ' + e.message); }
}

// ---- termos.js: girias protegidas antes de traduzir e devolvidas depois ----
const { proteger, restaurar, soTermos, definirTermosExtra } = require(path.join(raiz, 'termos.js'));
teste('protege girias, @usuario, $TICKER e links', () => {
  const { txt, mapa } = proteger('This will pump hard, @dev said $BONK is going to the moon https://x.com/a');
  for (const t of ['pump', '@dev', '$BONK', 'to the moon', 'https://x.com/a']) assert.ok(mapa.includes(t), 'faltou ' + t);
  assert.ok(!/pump|moon/i.test(txt), 'giria ficou no texto: ' + txt);
});
teste('restaura as marcas mesmo com espacos que o tradutor coloca', () => {
  const { txt, mapa } = proteger('big whale bought');
  const quebrado = txt.replace(/XQ(\w+)XQ/, 'X Q $1 X Q');
  const r = restaurar('grande ' + quebrado + ' comprou', mapa);
  assert.strictEqual(r.perdidos, 0); assert.ok(r.texto.includes('whale'), r.texto);
});
teste('variacoes (pumped, rugged) tambem sao protegidas', () => {
  const { mapa } = proteger('it pumped then rugged');
  assert.deepStrictEqual(mapa, ['pumped', 'rugged']);
});
teste('texto so com termos nao precisa traduzir', () => {
  assert.ok(soTermos(proteger('gm frens LFG').txt));
  assert.ok(!soTermos(proteger('gm frens, today is a great day').txt));
});
teste('palavras extras das configuracoes entram na protecao', () => {
  definirTermosExtra('send it\ncooking');
  assert.ok(proteger('we are so send it now').mapa.includes('send it'));
  definirTermosExtra('');
});
teste('token nao vira "ficha" na traducao', () => {
  assert.deepStrictEqual(proteger('One crew per token, 2 tokens').mapa, ['token', 'tokens']);
});
teste('nomes em chines voltam com o nome em ingles', () => {
  const { txt, mapa } = proteger('你想要的币安都有，比特币和币安链');
  assert.deepStrictEqual(mapa, ['Binance', 'Bitcoin', 'BNB Chain']);
  assert.ok(!/币安|比特币/.test(txt), txt);
  assert.ok(restaurar(txt, mapa).texto.includes('BNB Chain'));
});
teste('girias da BSC (four.meme, flap) ficam como estao', () => {
  assert.deepStrictEqual(proteger('launched on four.meme then flap').mapa, ['four.meme', 'flap']);
});
teste('endereco de contrato Solana nao e traduzido', () => {
  const ca = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
  assert.ok(proteger('CA: ' + ca).mapa.includes(ca));
});

// ---- idiomas.js: toda lingua da interface tem as mesmas chaves do ingles ----
const ctx = {}; new Function('ctx', ler('idiomas.js') + ';ctx.IDIOMAS = IDIOMAS; ctx.TEXTOS = TEXTOS; ctx.textoUI = textoUI;')(ctx);
teste('linguas da interface tem todos os textos', () => {
  const base = Object.keys(ctx.TEXTOS.en);
  for (const [l, t] of Object.entries(ctx.TEXTOS)) {
    const faltam = base.filter(k => !(k in t)), sobram = Object.keys(t).filter(k => !base.includes(k));
    assert.ok(!faltam.length && !sobram.length, l + ': faltam ' + faltam.join(',') + ' sobram ' + sobram.join(','));
  }
});
teste('textos usados no codigo existem', () => {
  const codigo = ['content.js', 'background.js', 'options.js', 'options.html'].map(ler).join('\n');
  const usadas = new Set([...codigo.matchAll(/\bT\('(\w+)'/g), ...codigo.matchAll(/data-th?="(\w+)"/g)].map(m => m[1]));
  const faltam = [...usadas].filter(k => !k.endsWith('_') && !(k in ctx.TEXTOS.en));   // 'n_' + funcao e montado na hora
  assert.deepStrictEqual(faltam, []);
});
teste('{a} e {b} sao trocados', () => assert.strictEqual(ctx.textoUI('pt', 'f_linksRuins', 2, 5), '2 de 5 páginas internas testadas não abrem'));
teste('lingua sem interface cai no ingles', () => assert.strictEqual(ctx.textoUI('ja', 'close'), 'Close'));

// ---- manifest: todo arquivo citado existe e todo script tem sintaxe valida ----
const manifest = JSON.parse(ler('manifest.json'));
teste('arquivos do manifest existem', () => {
  const arquivos = [manifest.background.service_worker, manifest.options_page, ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap(c => c.js)];
  for (const f of arquivos) assert.ok(fs.existsSync(path.join(raiz, f)), 'nao existe: ' + f);
});
teste('scripts sem erro de sintaxe', () => {
  for (const f of fs.readdirSync(raiz).filter(f => f.endsWith('.js'))) {
    try { new Function(ler(f).replace(/^importScripts\(.*$/m, '')); } catch (e) { throw new Error(f + ': ' + e.message); }
  }
});

console.log('\n' + ok + ' ok, ' + falhou + ' falharam');
process.exit(falhou ? 1 : 0);
