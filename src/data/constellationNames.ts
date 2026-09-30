/**
 * 西方 88 星座的 IAU 三字母缩写 → 中英文名。
 *
 * 星表里的 `con` 列用的就是三字母缩写，信息卡要显示中文名就得查这张表。
 * 顺序按缩写字母排列，方便查阅。
 */

export interface ConstellationName {
  /** 英文名 */
  en: string;
  /** 中文名 */
  zh: string;
}

export const CONSTELLATION_NAMES: Readonly<Record<string, ConstellationName>> = Object.freeze({
  And: { en: 'Andromeda', zh: '仙女座' },
  Ant: { en: 'Antlia', zh: '唧筒座' },
  Aps: { en: 'Apus', zh: '天燕座' },
  Aqr: { en: 'Aquarius', zh: '宝瓶座' },
  Aql: { en: 'Aquila', zh: '天鹰座' },
  Ara: { en: 'Ara', zh: '天坛座' },
  Ari: { en: 'Aries', zh: '白羊座' },
  Aur: { en: 'Auriga', zh: '御夫座' },
  Boo: { en: 'Boötes', zh: '牧夫座' },
  Cae: { en: 'Caelum', zh: '雕具座' },
  Cam: { en: 'Camelopardalis', zh: '鹿豹座' },
  Cnc: { en: 'Cancer', zh: '巨蟹座' },
  CVn: { en: 'Canes Venatici', zh: '猎犬座' },
  CMa: { en: 'Canis Major', zh: '大犬座' },
  CMi: { en: 'Canis Minor', zh: '小犬座' },
  Cap: { en: 'Capricornus', zh: '摩羯座' },
  Car: { en: 'Carina', zh: '船底座' },
  Cas: { en: 'Cassiopeia', zh: '仙后座' },
  Cen: { en: 'Centaurus', zh: '半人马座' },
  Cep: { en: 'Cepheus', zh: '仙王座' },
  Cet: { en: 'Cetus', zh: '鲸鱼座' },
  Cha: { en: 'Chamaeleon', zh: '蝘蜓座' },
  Cir: { en: 'Circinus', zh: '圆规座' },
  Col: { en: 'Columba', zh: '天鸽座' },
  Com: { en: 'Coma Berenices', zh: '后发座' },
  CrA: { en: 'Corona Australis', zh: '南冕座' },
  CrB: { en: 'Corona Borealis', zh: '北冕座' },
  Crv: { en: 'Corvus', zh: '乌鸦座' },
  Crt: { en: 'Crater', zh: '巨爵座' },
  Cru: { en: 'Crux', zh: '南十字座' },
  Cyg: { en: 'Cygnus', zh: '天鹅座' },
  Del: { en: 'Delphinus', zh: '海豚座' },
  Dor: { en: 'Dorado', zh: '剑鱼座' },
  Dra: { en: 'Draco', zh: '天龙座' },
  Equ: { en: 'Equuleus', zh: '小马座' },
  Eri: { en: 'Eridanus', zh: '波江座' },
  For: { en: 'Fornax', zh: '天炉座' },
  Gem: { en: 'Gemini', zh: '双子座' },
  Gru: { en: 'Grus', zh: '天鹤座' },
  Her: { en: 'Hercules', zh: '武仙座' },
  Hor: { en: 'Horologium', zh: '时钟座' },
  Hya: { en: 'Hydra', zh: '长蛇座' },
  Hyi: { en: 'Hydrus', zh: '水蛇座' },
  Ind: { en: 'Indus', zh: '印第安座' },
  Lac: { en: 'Lacerta', zh: '蝎虎座' },
  Leo: { en: 'Leo', zh: '狮子座' },
  LMi: { en: 'Leo Minor', zh: '小狮座' },
  Lep: { en: 'Lepus', zh: '天兔座' },
  Lib: { en: 'Libra', zh: '天秤座' },
  Lup: { en: 'Lupus', zh: '豺狼座' },
  Lyn: { en: 'Lynx', zh: '天猫座' },
  Lyr: { en: 'Lyra', zh: '天琴座' },
  Men: { en: 'Mensa', zh: '山案座' },
  Mic: { en: 'Microscopium', zh: '显微镜座' },
  Mon: { en: 'Monoceros', zh: '麒麟座' },
  Mus: { en: 'Musca', zh: '苍蝇座' },
  Nor: { en: 'Norma', zh: '矩尺座' },
  Oct: { en: 'Octans', zh: '南极座' },
  Oph: { en: 'Ophiuchus', zh: '蛇夫座' },
  Ori: { en: 'Orion', zh: '猎户座' },
  Pav: { en: 'Pavo', zh: '孔雀座' },
  Peg: { en: 'Pegasus', zh: '飞马座' },
  Per: { en: 'Perseus', zh: '英仙座' },
  Phe: { en: 'Phoenix', zh: '凤凰座' },
  Pic: { en: 'Pictor', zh: '绘架座' },
  Psc: { en: 'Pisces', zh: '双鱼座' },
  PsA: { en: 'Piscis Austrinus', zh: '南鱼座' },
  Pup: { en: 'Puppis', zh: '船尾座' },
  Pyx: { en: 'Pyxis', zh: '罗盘座' },
  Ret: { en: 'Reticulum', zh: '网罟座' },
  Sge: { en: 'Sagitta', zh: '天箭座' },
  Sgr: { en: 'Sagittarius', zh: '人马座' },
  Sco: { en: 'Scorpius', zh: '天蝎座' },
  Scl: { en: 'Sculptor', zh: '玉夫座' },
  Sct: { en: 'Scutum', zh: '盾牌座' },
  Ser: { en: 'Serpens', zh: '巨蛇座' },
  Sex: { en: 'Sextans', zh: '六分仪座' },
  Tau: { en: 'Taurus', zh: '金牛座' },
  Tel: { en: 'Telescopium', zh: '望远镜座' },
  Tri: { en: 'Triangulum', zh: '三角座' },
  TrA: { en: 'Triangulum Australe', zh: '南三角座' },
  Tuc: { en: 'Tucana', zh: '杜鹃座' },
  UMa: { en: 'Ursa Major', zh: '大熊座' },
  UMi: { en: 'Ursa Minor', zh: '小熊座' },
  Vel: { en: 'Vela', zh: '船帆座' },
  Vir: { en: 'Virgo', zh: '室女座' },
  Vol: { en: 'Volans', zh: '飞鱼座' },
  Vul: { en: 'Vulpecula', zh: '狐狸座' },
});

/** 三字母缩写 → 中文名，查不到就原样返回 */
export function constellationZh(abbr: string | undefined): string | undefined {
  if (!abbr) return undefined;
  return CONSTELLATION_NAMES[abbr]?.zh;
}

/**
 * AT-HYG 的 `bayer` 列用三字母拉丁转写（`Alp`、`Bet`、…），
 * 显示时应还原成希腊字母。带数字上标的（如 `Alp1`）保留数字。
 */
const BAYER_GREEK: Readonly<Record<string, string>> = Object.freeze({
  Alp: 'α', Bet: 'β', Gam: 'γ', Del: 'δ', Eps: 'ε', Zet: 'ζ', Eta: 'η',
  The: 'θ', Iot: 'ι', Kap: 'κ', Lam: 'λ', Mu: 'μ', Nu: 'ν', Xi: 'ξ',
  Omi: 'ο', Pi: 'π', Rho: 'ρ', Sig: 'σ', Tau: 'τ', Ups: 'υ', Phi: 'φ',
  Chi: 'χ', Psi: 'ψ', Ome: 'ω',
});

/**
 * 拜耳编号 → 希腊字母形式。
 * `Alp2` → `α²`，认不出来的原样返回。
 */
export function formatBayer(bayer: string | undefined): string | undefined {
  if (!bayer) return undefined;
  const match = /^([A-Za-z]{3})(\d*)$/.exec(bayer.trim());
  if (!match) return bayer;
  const greek = BAYER_GREEK[match[1]!];
  if (!greek) return bayer;
  const digits = match[2] ?? '';
  const superscript = digits.replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]!);
  return `${greek}${superscript}`;
}

/**
 * 拼一个天体的常用称呼：拜耳字母 + 星座中文名，例如 `α 牧夫座`。
 * 没有拜耳编号时退回弗兰斯蒂德号。
 */
export function formatDesignation(
  bayer: string | undefined,
  flam: string | undefined,
  constellationAbbr: string | undefined,
): string | undefined {
  const greek = formatBayer(bayer);
  const con = constellationZh(constellationAbbr);
  if (greek && con) return `${greek} ${con}`;
  if (greek) return greek;
  if (flam && con) return `${flam} ${con}`;
  if (flam) return flam;
  return con;
}
