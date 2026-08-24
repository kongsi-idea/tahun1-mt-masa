// 针对性验证：班级名单只有 1 人时的对垒模式（曾经的静默故障）+ 静音开关
import { chromium } from 'playwright';
const URL = 'http://localhost:8899/index.html';
let fails = 0;
const log=(...a)=>console.log(...a);
const check=(name,ok,extra='')=>{ log(`${ok?'  ✅':'  ❌'} ${name}${extra?' — '+extra:''}`); if(!ok) fails++; };

const b = await chromium.launch();

async function newPage(roster){
  const ctx = await b.newContext({viewport:{width:1440,height:900}});
  const page = await ctx.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push('PAGEERROR: '+e.message));
  page.on('console',m=>{
    if(m.type()!=='error') return;
    if(/Failed to load resource/.test(m.text())){ console.log('  ⓘ（外部资源载入失败，忽略）', m.text().slice(0,80)); return; }
    errors.push(m.text());
  });
  if(roster){
    await page.route('**/class-code-client.js', r=>r.fulfill({
      contentType:'application/javascript',
      body:'const ClassCode = { loadOrPrompt: async()=>window.__ROSTER||[], load: async()=>window.__ROSTER||[], expand:()=>[], codesFromUrl:()=>[] };',
    }));
    await page.addInitScript(rs=>{ window.__ROSTER=rs; }, roster);
  }
  await page.goto(URL,{waitUntil:'networkidle'});
  await page.evaluate(()=>document.fonts.ready);
  const skip=page.locator('button[data-act="skip"]'); if(await skip.count()) await skip.click();
  await page.locator('.hero-cta').click();
  await page.waitForTimeout(300);
  return {page, errors};
}

log('\n【edge-1】班级只有 1 位同学：对垒模式要能手动打名字，不能带空白名字直接开局');
{
  const roster=[{name:'独苗',nameZh:'独苗',nameEn:null,seatNo:1,className:'测试1I',schoolName:'测试小学',playCode:'TEST-SOLO1'}];
  const {page,errors} = await newPage(roster);
  check('不该出现「已就绪」抽签框（人数不够抽签）', await page.locator('.rosterbox').count()===0);
  check('改成显示手动输入框', await page.locator('.pslot.p1 input').count()===1);
  const hintTxt = await page.locator('.hint').allInnerTexts();
  check('有明确提示「人数不够自动抽签」', hintTxt.some(t=>t.includes('人数不够')), hintTxt.join(' / ').slice(0,80));
  check('按钮初始是禁用的（还没打名字）', await page.locator('.btn.big').isDisabled());
  await page.locator('.pslot.p1 input').fill('小明');
  await page.locator('.pslot.p2 input').fill('小美');
  check('填完两个名字后按钮可按', !(await page.locator('.btn.big').isDisabled()));
  await page.locator('.btn.big').click();
  await page.waitForSelector('.arena');
  const names = await page.evaluate(()=>[...document.querySelectorAll('.side .nm')].map(e=>e.textContent));
  check('进入对战画面时名字是刚打的，不是空白', names.includes('小明') && names.includes('小美'), names.join(','));
  check('没有 JS 报错', errors.length===0, errors.join(' | '));
  await page.context().close();
}

log('\n【edge-2】静音开关：默认有声，切一次会记住');
{
  const {page,errors} = await newPage(null);
  const before = await page.locator('.iconbtn').first().getAttribute('title');
  check('默认标题是「关闭声音」（代表现在有声）', before==='关闭声音', before);
  await page.locator('.iconbtn').first().click();
  await page.waitForTimeout(150);
  const after = await page.locator('.iconbtn').first().getAttribute('title');
  check('点一次后变成「打开声音」', after==='打开声音', after);
  const stored = await page.evaluate(()=>localStorage.getItem('masa_muted'));
  check('静音状态存进 localStorage', stored==='1', stored);
  await page.reload({waitUntil:'networkidle'});
  await page.waitForTimeout(300);
  const afterReload = await page.locator('.iconbtn').first().getAttribute('title');
  check('刷新页面后静音状态还记得', afterReload==='打开声音', afterReload);
  check('没有 JS 报错', errors.length===0, errors.join(' | '));
  await page.context().close();
}

log('\n【edge-3】班级完全没有名单：对垒/自由作答都要能正常手动进行');
{
  const {page,errors} = await newPage([]);
  check('没有名单时不出现「已就绪」框', await page.locator('.rosterbox').count()===0);
  await page.locator('.pslot.p1 input').fill('阿花');
  await page.locator('.pslot.p2 input').fill('阿强');
  await page.locator('.btn.big').click();
  await page.waitForSelector('.arena');
  check('没有名单也能正常开局', await page.locator('.clockbox').count()===2);
  check('没有 JS 报错', errors.length===0, errors.join(' | '));
  await page.context().close();
}

log('\n【edge-4】自由作答 + 没有班级名单：名字栏要是手动输入框，不是下拉选单');
{
  const {page,errors} = await newPage([]);
  await page.locator('.modebtn',{hasText:'自由作答'}).click();
  check('solo 名字栏是 input 不是 select', await page.locator('.pslot.p1 input').count()===1);
  await page.locator('.pslot.p1 input').fill('自己练习的小朋友');
  await page.locator('.btn.big').click();
  await page.waitForSelector('.arena');
  check('单人模式只有 1 个钟', await page.locator('.clockbox').count()===1);
  check('没有 JS 报错', errors.length===0, errors.join(' | '));
  await page.context().close();
}

log('\n【edge-5】记住上次设定：换宽容度/题数/关辅助线后刷新还在，但名字不留');
{
  const {page,errors} = await newPage([]);
  const openMore = async()=>{
    const btn = page.locator('.morebtn');
    if(await btn.getAttribute('aria-expanded')!=='true') await btn.click();
    await page.waitForTimeout(120);
  };
  await openMore();
  await page.locator('.chip.mini',{hasText:'严格'}).click();
  await page.locator('.chip.mini',{hasText:'12 题'}).click();
  await page.locator('.chip.mini',{hasText:'钟面显示一刻辅助线'}).click();   // 原本开着，关掉它
  await page.locator('.pslot.p1 input').fill('小明');
  // 不猜固定延迟：真的等 useEffect 把 cfg 写进 localStorage 再刷新，避免时序竞争造成偶发失败
  await page.waitForFunction(() => {
    const s = localStorage.getItem('masa_cfg_v1');
    return s && s.includes('strict') && s.includes('12');
  }, null, { timeout: 3000 });

  await page.reload({waitUntil:'networkidle'});
  await page.evaluate(()=>document.fonts.ready);
  const skip=page.locator('button[data-act="skip"]'); if(await skip.count()) await skip.click();
  await page.locator('.hero-cta').click();
  await page.waitForTimeout(300);
  await openMore();
  const on = await page.locator('.chip.mini.on').allInnerTexts();
  check('刷新后宽容度还是「严格」', on.includes('严格'), on.join(','));
  check('刷新后题数还是「12 题」', on.includes('12 题'), on.join(','));
  check('刷新后「辅助线」保持关闭状态', !on.includes('钟面显示一刻辅助线'), on.join(','));
  check('名字栏刷新后是空的（不留上一个学生的名字）', await page.locator('.pslot.p1 input').inputValue()==='');
  check('没有 JS 报错', errors.length===0, errors.join(' | '));
  await page.context().close();
}

log(`\n${fails===0?'全部通过 ✅':`有 ${fails} 项没过 ❌`}`);
await b.close();
process.exit(fails?1:0);
