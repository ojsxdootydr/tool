// Palavras do mundo cripto que NAO devem ser traduzidas (o tradutor automatico estraga: pump vira "bomba", moon vira "lua").
// Cada uma e trocada por uma marca antes de traduzir e devolvida depois. Variacoes (pumps, pumped, pumping) tambem valem.
const TERMOS_BASE = `
pump dump rug rugpull rugged bag bagholder bull bullish bear bearish moon mooning moonshot whale shrimp ape aped aping degen degens
hodl holder holders dip btfd flip flipped shill shilling shiller airdrop wick nuke nuked jeet jeets rekt cope cooking cook
cabal insider insiders bundle bundled bundler sniper snipers sniped sniping bot bots mev honeypot alpha meta metas gem gems chad giga
normie anon anons fren frens gm gn wen wagmi ngmi lfg fud fomo fomo'd dyor nfa tgif ath atl mc mcap fdv tvl dca roi pnl tp sl
kol kols cto dex cex tge ico ido kyc rpc tx txs lp ca dev devs bonk wl whitelist mint minted minting swap swaps bridge perp perps
farming farmer farmers altcoin altcoins alts shitcoin shitcoins memecoin memecoins stablecoin stablecoins degenerate
graduate graduated graduating migrate migrated trenches trench copytrade copytrading wallet-tracker floor-price
send-it full-send paper-hands diamond-hands weak-hands strong-hands exit-liquidity rug-pull dev-sold dev-sell bonding-curve
market-cap all-time-high all-time-low take-profit stop-loss buy-the-dip to-the-moon ape-in apes-in liquidity-pool lp-burned
mint-authority freeze-authority top-signal pump-and-dump pump-fun pump.fun final-stretch new-pairs quick-buy
token tokens ticker tickers launchpad four.meme fourmeme flap pancakeswap bsc bnb
solana sol eth btc usdc usdt nft nfts dao defi rwa dapp dapps web3 on-chain onchain off-chain offchain tokenomics
jupiter phantom raydium orca meteora axiom photon trojan bullx gmgn birdeye helius jito binance coinbase kraken ledger metamask
backpack uniswap hyperliquid dexscreener dextools rugcheck bubblemaps solscan solanafm moonshot-app magic-eden
`.split(/\s+/).map(s => s.trim()).filter(Boolean).map(s => s.replace(/-/g, ' '));

// Nomes de cripto em chines: o tradutor traduz cada caractere (币安 vira "seguranca de moedas").
// Eles saem do texto antes de traduzir e voltam com o nome conhecido em ingles.
const NOMES_ZH = {
  '币安链': 'BNB Chain', '币安': 'Binance', '比特币': 'Bitcoin', '以太坊': 'Ethereum', '狗狗币': 'Dogecoin', '索拉纳': 'Solana',
  '欧易': 'OKX', '火币': 'HTX', '波场': 'TRON', '赵长鹏': 'CZ', '何一': 'Yi He', '孙宇晨': 'Justin Sun',
  '马斯克': 'Musk', '特朗普': 'Trump', '川普': 'Trump', '合约地址': 'CA', '土狗': 'memecoin', '冲土狗': 'ape into memecoins',
};
const REGEX_ZH = new RegExp(Object.keys(NOMES_ZH).sort((a, b) => b.length - a.length).join('|'), 'g');

let TERMOS_EXTRA = [];
function definirTermosExtra(txt) { TERMOS_EXTRA = String(txt || '').split(/[\n,;]+/).map(s => s.trim()).filter(s => s.length >= 2); montarRegex(); }

let REGEX_TERMOS = null;
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
function variantes(w) {
  if (w.length <= 3 || /\s/.test(w)) return [w, w + 's'];   // siglas e frases: so a forma exata (e plural simples)
  const v = [w, w + 's', w + 'es', w + 'ed', w + 'ing', w + 'er', w + 'ers'];
  if (w.endsWith('e')) v.push(w + 'd', w.slice(0, -1) + 'ing', w + 'r', w + 'rs');
  return v;
}
function montarRegex() {
  const todos = Array.from(new Set(TERMOS_BASE.concat(TERMOS_EXTRA).map(s => s.toLowerCase())));
  const formas = Array.from(new Set(todos.flatMap(variantes))).sort((a, b) => b.length - a.length);
  const palavras = formas.map(escRe).join('|');
  // ordem: links, enderecos (carteira/contrato), @usuario, #tag, $TICKER, depois os termos
  REGEX_TERMOS = new RegExp(
    '(https?:\\/\\/\\S+)|(\\b[1-9A-HJ-NP-Za-km-z]{32,44}\\b)|(\\b0x[a-fA-F0-9]{40}\\b)|(@\\w{2,})|(#\\w{2,})|(\\$[A-Za-z0-9_]{2,})|' +
    "(?<![\\p{L}\\p{N}_])(?:" + palavras + ")(?![\\p{L}\\p{N}_])", 'giu');
}
montarRegex();

const ALFA = 'ABCDEFGHIJKLMNOPRSTUVWYZ'; // sem X nem Q, para a marca nunca se confundir com o XQ das pontas
const MARCA = n => { let s = '', x = n; do { s = ALFA[x % 24] + s; x = Math.floor(x / 24) - 1; } while (x >= 0); return 'XQ' + s + 'XQ'; };
function proteger(texto) {
  const mapa = [];
  const txt = String(texto).replace(REGEX_ZH, m => { mapa.push(NOMES_ZH[m]); return ' ' + MARCA(mapa.length - 1) + ' '; })
    .replace(REGEX_TERMOS, m => { mapa.push(m); return MARCA(mapa.length - 1); });
  return { txt, mapa };
}
function restaurar(traduzido, mapa) {
  const usados = new Set();
  const out = String(traduzido).replace(/X\s?Q\s?([A-PR-WYZ]{1,3})\s?X\s?Q/gi, (m, letras) => {
    let n = 0; for (const ch of letras.toUpperCase()) n = n * 24 + ALFA.indexOf(ch) + 1;
    n -= 1; if (n < 0 || n >= mapa.length) return m;
    usados.add(n); return mapa[n];
  });
  return { texto: out, perdidos: mapa.length - usados.size };
}
// so sobrou termo protegido (ou nada de letras)? entao nao precisa traduzir
function soTermos(txt) { return !/\p{L}/u.test(String(txt).replace(/XQ[A-PR-WYZ]{1,3}XQ/g, ' ')); }
if (typeof module !== 'undefined') module.exports = { proteger, restaurar, soTermos, definirTermosExtra, TERMOS_BASE };
