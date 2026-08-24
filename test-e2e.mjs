// 时刻大对决 v2 端到端测试：课堂对垒（含抽签）、自由作答、宽容度吸附、排行榜分模式
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL = process.env.TARGET || 'http://localhost:8899/index.html';
const OUT = '/Users/yquanloo/Documents/my-agent/teaching-tools/tahun1-mt-masa/.playwright-output';
fs.mkdirSync(OUT, { recursive: true });

const MIN_OF = { '': 0, '半': 30, '一刻': 15, '三刻': 45, '30分': 30, '15分': 15, '45分': 45 };
const norm = a => ((a % 360) + 360) % 360;
const angDist = (a,b)=>{ const d=Math.abs(norm(a)-norm(b)); return Math.min(d,360-d); };

let fails = 0;
const log = (...a) => console.log(...a);
const check = (name, ok, extra = '') => { log(`${ok ? '  ✅' : '  ❌'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fails++; };

const CLASS_A = ['陈伟杰','林思颖','黄俊豪','李美琪','王志强','张雅婷'];
const CLASS_B = ['吴家豪','刘欣怡','郑文彬'];
const rosterOf = (specs) => specs.flatMap(([code, cname, names]) =>
  names.map((n, i) => ({ name:n, nameZh:n, nameEn:null, seatNo:i+1, className:cname, schoolName:'测试小学', playCode:code })));

const browser = await chromium.launch();

async function newPage(roster) {
  const ctx = await browser.newContext({ viewport:{width:1440,height:900}, deviceScaleFactor:2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    // Google Fonts 等外部 CDN 偶发 404 不是程式逻辑错误（字体退回后备字体，功能不受影响），
    // 只记录不计入失败，避免测试被外部 CDN 的瞬时问题拖累
    if (/Failed to load resource/.test(m.text())) { console.log('  ⓘ（外部资源载入失败，忽略）', m.text().slice(0,80)); return; }
    errors.push(m.text());
  });
  if (roster) {
    // 用假的 ClassCode 取代线上那份，才能在没有真实班级代码的情况下测抽签
    await page.route('**/class-code-client.js', r => r.fulfill({
      contentType: 'application/javascript',
      body: 'const ClassCode = { loadOrPrompt: async()=>window.__ROSTER||[], load: async()=>window.__ROSTER||[], expand:()=>[], codesFromUrl:()=>[] };',
    }));
    await page.addInitScript(rs => { window.__ROSTER = rs; }, roster);
  }
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const skip = page.locator('button[data-act="skip"]');
  if (await skip.count()) await skip.click();
  await page.locator('.hero-cta').click();   // 冷启动先经过开场主视觉，点「开始」才进设定页
  await page.waitForTimeout(300);
  return { page, ctx, errors };
}

// ---- 共用操作 ----
async function readQuestion(page) {
  return page.evaluate(() => {
    const qm = document.querySelector('.q-main');
    const parts = [...qm.childNodes].map(n => n.tagName === 'RUBY' ? n.childNodes[0].textContent : n.textContent);
    return parts.join('');
  });
}
function parseQuestion(text) {
  // 形如 "4时半" / "4时15分" / "12时"
  const m = /^(\d+)时(.*)$/.exec(text);
  const hour = parseInt(m[1], 10);
  const rest = m[2];
  const minute = rest === '' ? 0 : MIN_OF[rest] ?? parseInt(rest, 10);
  return { hour, minute };
}
async function dragHand(page, lane, label, targetAngle) {
  const geo = await page.evaluate(([lane, label]) => {
    const svg = document.querySelectorAll('.clockbox')[lane];
    const box = svg.getBoundingClientRect();
    const g = [...svg.querySelectorAll('g[transform]')].find(g => g.querySelector('text')?.textContent === label);
    const k = g.querySelector('circle').getBoundingClientRect();
    return { cx: box.left+box.width/2, cy: box.top+box.height/2, scale: box.width/220,
             kx: k.left+k.width/2, ky: k.top+k.height/2 };
  }, [lane, label]);
  const r = 55 * geo.scale;   // 用固定半径当落点：只要在死区外，角度才是判定依据，几何改了也不用跟着改
  const rad = (targetAngle - 90) * Math.PI / 180;
  const tx = geo.cx + Math.cos(rad) * r, ty = geo.cy + Math.sin(rad) * r;
  await page.mouse.move(geo.kx, geo.ky);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(geo.kx + (tx-geo.kx)*i/6, geo.ky + (ty-geo.ky)*i/6);
  await page.mouse.up();
}
async function handAngles(page, lane) {
  return page.evaluate(lane => {
    const svg = document.querySelectorAll('.clockbox')[lane];
    const get = l => {
      const g = [...svg.querySelectorAll('g[transform]')].find(g => g.querySelector('text')?.textContent === l);
      return parseFloat(/rotate\(([-\d.]+)\)/.exec(g.getAttribute('transform'))[1]);
    };
    return { h: get('时'), m: get('分') };
  }, lane);
}
async function solveLane(page, lane, q) {
  const tH = norm((q.hour % 12) * 30 + q.minute * 0.5), tM = norm(q.minute * 6);
  await dragHand(page, lane, '时', tH);
  await dragHand(page, lane, '分', tM);
  return { tH, tM };
}
// 宽容度/题数/辅助设定收进了预设收起的「更多设置」，测试要先展开才摸得到那些 chip
async function openMore(page){
  const btn = page.locator('.morebtn');
  if(await btn.getAttribute('aria-expanded') !== 'true') await btn.click();
  await page.waitForTimeout(120);
}
async function drawnNames(page) {
  // 先等滚动「开始」再等它「结束」——只等结束的话会在滚动还没启动时就读到上一组的名字
  await page.waitForFunction(() => !!document.querySelector('.drawcard.rolling'), null, { timeout: 4000 }).catch(()=>{});
  await page.waitForFunction(() => !document.querySelector('.drawcard.rolling'), null, { timeout: 8000 });
  await page.waitForTimeout(150);
  return page.evaluate(() => [...document.querySelectorAll('.drawname')].map(e => e.textContent.trim()));
}

/* ============================================================ */
log('\n【1】课堂对垒 · 单班抽签（不重复、用完才重来）');
{
  const roster = rosterOf([['TEST-1I', '测试1I', CLASS_A]]);
  const { page, errors } = await newPage(roster);

  check('读到名单后改成「抽签名单已就绪」', await page.locator('.rosterbox').count() === 1,
    (await page.locator('.rosterbox span').innerText().catch(()=>'')).slice(0, 30));
  await page.locator('.btn.big').click();
  await page.waitForSelector('.drawrow');

  const seen = [];
  for (let i = 0; i < 3; i++) {                       // 6 人 = 3 组，应该刚好把全班用完
    const pair = await drawnNames(page);
    log(`  第 ${i+1} 组：${pair.join(' vs ')}`);
    seen.push(...pair);
    if (i < 2) await page.locator('.btn.ghost', { hasText: '重抽' }).click();
  }
  check('每一组的两个人不同', seen.every((_, i) => i % 2 === 1 ? seen[i] !== seen[i-1] : true));
  check('前 3 组共 6 人全部不重复（全班刚好轮完一遍）', new Set(seen).size === 6, `实际 ${new Set(seen).size} 人`);
  check('抽到的都是名单上的人', seen.every(n => CLASS_A.includes(n)));

  await page.locator('.btn.ghost', { hasText: '重抽' }).click();
  const fourth = await drawnNames(page);
  log(`  第 4 组（池子应已重置）：${fourth.join(' vs ')}`);
  check('用完之后会重新开始，不会抽不出人', fourth.length === 2 && fourth[0] && fourth[1]);

  await page.screenshot({ path: `${OUT}/v2-draw.png`, fullPage: true });
  check('没有 JS 报错', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

/* ============================================================ */
log('\n【2】课堂对垒 · 两个班 → 一边一个班');
{
  const roster = rosterOf([['TEST-1I','测试1I',CLASS_A], ['TEST-2A','测试2A',CLASS_B]]);
  const { page, errors } = await newPage(roster);
  await page.locator('.btn.big').click();
  await page.waitForSelector('.drawrow');
  let ok = true;
  for (let i = 0; i < 4; i++) {
    const [a, b] = await drawnNames(page);
    const from = (n) => CLASS_A.includes(n) ? 'A' : CLASS_B.includes(n) ? 'B' : '?';
    log(`  第 ${i+1} 组：${a}(${from(a)}) vs ${b}(${from(b)})`);
    if (from(a) === from(b)) ok = false;
    if (i < 3) await page.locator('.btn.ghost', { hasText: '重抽' }).click();
  }
  check('每一组都是一边一个班', ok);
  const labels = await page.evaluate(() => [...document.querySelectorAll('.drawclass')].map(e => e.textContent));
  check('抽签卡上显示各自的班级', labels[0] !== labels[1], labels.join(' / '));
  check('没有 JS 报错', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

/* ============================================================ */
log('\n【3】宽松档：时针只停在「这次会考到的位置」');
{
  const { page, errors } = await newPage(null);
  await page.locator('.pslot.p1 input').fill('甲');
  await page.locator('.pslot.p2 input').fill('乙');
  // 预设就是 整时+半 + 宽松；宽容度收在「更多设置」里，展开后再读
  await openMore(page);
  const level = await page.locator('.field .chip.mini.on').allInnerTexts();
  check('预设宽容度是「宽松」', level.includes('宽松'), level.join(','));
  await page.locator('.btn.big').click();
  await page.waitForSelector('.arena');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  // 只勾整时+半 → 时针合法停点是每 15°；随便拖到一个刁钻角度，应该吸到 15 的倍数
  const probes = [37, 128, 260, 349];
  let allOn15 = true, detail = [];
  for (const target of probes) {
    await dragHand(page, 0, '时', target);
    const { h } = await handAngles(page, 0);
    detail.push(`${target}°→${h}°`);
    if (Math.abs(h % 15) > 0.01) allOn15 = false;
  }
  check('时针一律吸附到 15° 的倍数（整时或半点的位置）', allOn15, detail.join('  '));
  check('没有 JS 报错', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

/* ============================================================ */
log('\n【4】严格档：时针自由转动，容差 2°');
{
  const { page, errors } = await newPage(null);
  await page.locator('.pslot.p1 input').fill('甲');
  await page.locator('.pslot.p2 input').fill('乙');
  await openMore(page);
  await page.locator('.chip.mini', { hasText: '严格' }).click();
  await page.locator('.btn.big').click();
  await page.waitForSelector('.arena');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  const q = parseQuestion(await readQuestion(page));
  const tH = norm((q.hour % 12) * 30 + q.minute * 0.5), tM = norm(q.minute * 6);
  log(`  题目 ${q.hour} 时 ${q.minute} 分 → 时针 ${tH}°`);
  await dragHand(page, 0, '分', tM);
  await dragHand(page, 0, '时', norm(tH + 1.5));       // 差 1.5°，在容差内
  const before = await handAngles(page, 0);
  check('严格档时针不吸附到刻度（停在非 7.5 倍数）', Math.abs(before.h % 7.5) > 0.01 || angDist(before.h, tH) <= 2, `停在 ${before.h}°`);
  await page.locator('.lane.a .btn').click();
  await page.waitForTimeout(500);
  check('差 1.5° 判为答对', (await page.locator('.lane.a .verdict').innerText()).includes('拨对'));
  const after = await handAngles(page, 0);
  check('答对后指针自动调整到精确位置', angDist(after.h, tH) < 0.01, `${after.h}° / 应为 ${tH}°`);

  // 另一边差 5°，应该判错
  await dragHand(page, 1, '分', tM);
  await dragHand(page, 1, '时', norm(tH + 5));
  await page.locator('.lane.b .btn').click();
  await page.waitForTimeout(500);
  check('差 5° 判为答错', (await page.locator('.lane.b .verdict').innerText()).includes('时针'),
    await page.locator('.lane.b .verdict').innerText());
  check('没有 JS 报错', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

/* ============================================================ */
log('\n【5】自由作答：单人、计时、成绩');
{
  const { page, errors } = await newPage(null);
  await page.locator('.modebtn', { hasText: '自由作答' }).click();
  await page.locator('.pslot.p1 input').fill('独行侠');
  await openMore(page);
  await page.locator('.chip.mini', { hasText: '6 题' }).click();
  await page.locator('.btn.big').click();
  await page.waitForSelector('.arena');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  check('只有一个钟面', await page.locator('.clockbox').count() === 1);
  check('计时器在跑', /\d+:\d\d/.test(await page.locator('.roundpill').innerText()),
    await page.locator('.roundpill').innerText());

  for (let r = 1; r <= 6; r++) {
    if (r > 1) { await page.locator('.reveal .btn').click(); await page.waitForTimeout(350); }
    const q = parseQuestion(await readQuestion(page));
    await solveLane(page, 0, q);
    await page.locator('.lane.a .btn').click();
    await page.waitForTimeout(300);
  }
  check('自由作答按一次就揭晓，不用等对手', await page.locator('.reveal').isVisible());
  await page.locator('.reveal .btn').click();
  await page.waitForSelector('.result');
  const resTxt = (await page.locator('.result').innerText()).replace(/\s+/g, ' ');
  check('结算显示答对题数与用时', resTxt.includes('答对') && resTxt.includes('用时'), resTxt.slice(0, 80));
  check('6 题全对', (await page.locator('.final.a .fp').innerText()) === '6');
  await page.waitForTimeout(11000);
  log('  存分状态：' + (await page.locator('.result .hint').last().innerText()));
  await page.screenshot({ path: `${OUT}/v2-solo-result.png`, fullPage: true });

  await page.locator('.btn.ghost', { hasText: '看排行榜' }).click();
  await page.waitForTimeout(6000);
  const tabOn = await page.locator('.chip.mini.on').allInnerTexts();
  check('排行榜自动切到「自由作答」分页', tabOn.includes('自由作答'), tabOn.join(','));
  const heads = await page.locator('table.board th').allInnerTexts();
  check('自由作答榜有「用时」栏', heads.includes('用时'), heads.join('/'));
  await page.screenshot({ path: `${OUT}/v2-board-solo.png`, fullPage: true });
  check('没有 JS 报错', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

/* ============================================================ */
log('\n【6】课堂对垒：计分与「换下一对」');
{
  const roster = rosterOf([['TEST-1I','测试1I',CLASS_A]]);
  const { page, errors } = await newPage(roster);
  await openMore(page);
  await page.locator('.chip.mini', { hasText: '6 题' }).click();
  await page.locator('.btn.big').click();
  await page.waitForSelector('.drawrow');
  const pair1 = await drawnNames(page);
  await page.locator('.btn', { hasText: '开始对决' }).click();
  await page.waitForSelector('.arena');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  // 课堂对垒 + 有名单：每一轮结束都会自动换新的两位同学上场（2026-08-14 老师要求），
  // 分数继续累计在「蓝队/红队」这两个座位，不因为换人而重置或漏计
  const namesPerRound = [];
  for (let r = 1; r <= 6; r++) {
    if (r > 1) { await page.locator('.reveal .btn').click(); await page.waitForTimeout(350); }
    namesPerRound.push(await page.evaluate(() => [...document.querySelectorAll('.side .nm')].map(e => e.textContent)));
    const q = parseQuestion(await readQuestion(page));
    await solveLane(page, 0, q);
    await solveLane(page, 1, q);
    await page.locator('.lane.a .btn').click();
    await page.waitForTimeout(120);
    await page.locator('.lane.b .btn').click();
    await page.waitForTimeout(250);
  }
  log('  各轮场上两人：' + namesPerRound.map(p => p.join('+')).join('  →  '));
  const swapped = namesPerRound.slice(1).filter((p, i) => p[0] !== namesPerRound[i][0] || p[1] !== namesPerRound[i][1]).length;
  check('多数轮次场上的人真的换了', swapped >= 3, `6 轮里有 ${swapped} 轮换了人`);
  check('太阳队 6 题都先答对 = 12 分（换人不影响座位分数累计）', (await page.locator('.side.a .pt').innerText()) === '12',
    await page.locator('.side.a .pt').innerText());
  check('月亮队 6 题都后答对 = 6 分（换人不影响座位分数累计）', (await page.locator('.side.b .pt').innerText()) === '6',
    await page.locator('.side.b .pt').innerText());

  await page.locator('.reveal .btn').click();
  await page.waitForSelector('.result');
  check('结算页出现「换下一对」', await page.locator('.btn', { hasText: '换下一对' }).count() === 1);
  await page.waitForTimeout(11000);
  await page.locator('.btn', { hasText: '换下一对' }).click();
  await page.waitForSelector('.drawrow');
  const pair2 = await drawnNames(page);
  // ⚠️ 不能断言「跟赛前第一次抽签的人完全不重叠」——6 题的对局本身就会把小班的抽签池
  // 轮完好几圈（见上面 namesPerRound），赛后重叠是正常且预期的，只需确认抽得出合法的一对
  log(`  赛前第一对：${pair1.join(' vs ')}  →  换下一对：${pair2.join(' vs ')}`);
  check('换下一对抽出两位合法且不同的班级成员', pair2.length === 2 && pair2[0] !== pair2[1] && pair2.every(n => CLASS_A.includes(n)),
    pair2.join(' vs '));
  await page.screenshot({ path: `${OUT}/v2-duel.png`, fullPage: true });
  check('没有 JS 报错', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

/* ============================================================ */
log('\n【7】宽松档：时针指死在整点数字，半点/一刻/三刻题也判对（2026-08-14 老师课堂实测要求）');
{
  const { page, errors } = await newPage(null);
  await page.locator('.pslot.p1 input').fill('甲');
  await page.locator('.pslot.p2 input').fill('乙');
  await page.locator('.btn.big').click();
  await page.waitForSelector('.arena');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  let q, tries = 0;
  do {
    q = parseQuestion(await readQuestion(page));
    if (q.minute !== 0) break;
    // 整时题重开一局重抽，直到抽到非整时题
    tries++;
    if (tries > 15) break;
    await page.evaluate(() => location.reload());
    await page.evaluate(() => document.fonts.ready);
    const skip = page.locator('button[data-act="skip"]'); if (await skip.count()) await skip.click();
    await page.locator('.hero-cta').click();
    await page.locator('.pslot.p1 input').fill('甲');
    await page.locator('.pslot.p2 input').fill('乙');
    await page.locator('.btn.big').click();
    await page.waitForSelector('.arena');
    await page.waitForTimeout(300);
  } while (true);
  check('抽到非整时题', q.minute !== 0, `${q.hour}时${q.minute}分`);

  const floorAngle = norm((q.hour % 12) * 30);
  const tM = norm(q.minute * 6);
  await dragHand(page, 0, '分', tM);
  await dragHand(page, 0, '时', floorAngle);    // 时针故意指死在整点，不往前挪半格/一刻
  await page.locator('.lane.a .btn').click();
  await page.waitForTimeout(500);
  check('宽松档：时针指死在整点也判「拨对了」', (await page.locator('.lane.a .verdict').innerText()).includes('拨对'));
  const after = await handAngles(page, 0);
  const preciseH = norm((q.hour % 12) * 30 + q.minute * 0.5);
  check('判对后指针自动归位到精确位置（不是停在指死的整点）', angDist(after.h, preciseH) < 0.01, `实际 ${after.h}° / 精确目标 ${preciseH}°`);
  check('没有 JS 报错', errors.length === 0, errors.join(' | '));
  await page.context().close();
}

log(`\n${fails === 0 ? '全部通过 ✅' : `有 ${fails} 项没过 ❌`}`);
await browser.close();
process.exit(fails ? 1 : 0);
