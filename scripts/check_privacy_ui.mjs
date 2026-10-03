// Browser tests use simulated SDK events; they do not authorize a real account.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { browserTest, sleep } from '../../QYB/yibao-query/scripts/browser_harness.mjs'

const checks = []
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS ' + name) }
await browserTest({ root: 'G:/qhyb-miniapp/dist/build/h5', width: 375, height: 812 }, async b => {
  await b.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true })
  b.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const body = request.url.includes('/api/search/terms') ? { entries: [] } : { error: 'isolated privacy UI test' }
    await b.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }, { name: 'access-control-allow-origin', value: '*' }, { name: 'access-control-allow-headers', value: '*' }],
      body: Buffer.from(JSON.stringify(body)).toString('base64') })
  })
  await b.send('Fetch.enable', { patterns: [{ urlPattern: 'https://qhyb.lynkco.site/api/*' }] })
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.privacyProbe = { answers: [], opens: 0, fail: false };
    let privacyWx = {
      onNeedPrivacyAuthorization(fn) { window.privacyProbe.listener = fn; },
      openPrivacyContract(options) { window.privacyProbe.opens++; if (window.privacyProbe.fail) options.fail(); }
    };
    // uni H5 initializes window.wx during boot; retain the two test hooks.
    Object.defineProperty(window, 'wx', { configurable: true, get: () => privacyWx,
      set: value => { Object.assign(value, privacyWx); privacyWx = value; } });
    window.privacyProbe.request = () => window.privacyProbe.listener(value => window.privacyProbe.answers.push(value));
  ` })
  await b.send('Page.navigate', { url: b.origin + '/#/pages/register/register' })
  await b.waitFor(`!!document.querySelector('.login-form') && !!window.privacyProbe.listener`)
  await b.eval(`window.privacyProbe.request()`)
  await b.waitFor(`!!document.querySelector('.privacy-dialog')`)
  check('SDK callback shows the privacy dialog and stays pending', await b.eval(`window.privacyProbe.answers.length === 0`))
  await b.eval(`document.querySelector('.privacy-contract').click()`)
  check('viewing the contract keeps the choice pending', await b.eval(`window.privacyProbe.opens === 1 && window.privacyProbe.answers.length === 0 && !!document.querySelector('.privacy-dialog')`))
  await b.eval(`window.privacyProbe.fail = true; document.querySelector('.privacy-contract').click()`)
  await sleep(150)
  check('contract failure cannot grant authorization', await b.eval(`window.privacyProbe.answers.length === 0`))
  await b.eval(`document.querySelector('.privacy-decline').click()`)
  await b.waitFor(`!document.querySelector('.privacy-dialog')`)
  check('decline resolves with disagree', await b.eval(`window.privacyProbe.answers[0].event === 'disagree'`))
  await b.eval(`window.privacyProbe.request(); window.privacyProbe.request()`)
  await b.waitFor(`!!document.querySelector('.privacy-agree')`)
  await b.eval(`document.querySelector('.privacy-agree').click()`)
  check('ordinary tap is insufficient for agreement', await b.eval(`window.privacyProbe.answers.length === 1`))
  await b.eval(`document.querySelector('.privacy-agree').dispatchEvent(new CustomEvent('agreeprivacyauthorization', { bubbles: true }))`)
  await b.waitFor(`window.privacyProbe.answers.length === 3`)
  check('native consent event resolves all pending callbacks with the button ID', await b.eval(`window.privacyProbe.answers.slice(1).every(v => v.event === 'agree' && v.buttonId === 'qhyb-privacy-agree')`))

  for (const language of ['zh', 'en', 'bo']) {
    await b.eval(`localStorage.setItem('qhyb.locale', JSON.stringify({ type: 'string', data: '${language}' }))`)
    await b.send('Page.navigate', { url: `${b.origin}/?language=${language}#/pages/register/register` })
    await b.waitFor(`!!document.querySelector('.login-form') && !!window.privacyProbe.listener`)
    await b.eval(`window.privacyProbe.request()`)
    await b.waitFor(`!!document.querySelector('.privacy-dialog')`)
    if (language === 'bo') await sleep(700)
    check(`${language} dialog fits a narrow screen`, await b.eval(`(() => {
      const box = document.querySelector('.privacy-dialog').getBoundingClientRect();
      const agree = document.querySelector('.privacy-agree').getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && agree.bottom <= innerHeight && !document.querySelector('.privacy-decline').innerText.includes('privacy.');
    })()`))
    await writeFile(`G:/QYB/tmp/privacy-${language}-ui.png`, Buffer.from((await b.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  }
  check('no uncaught page exceptions', b.errors.length === 0)
})
await writeFile('G:/QYB/tmp/privacy-ui-result.json', JSON.stringify({ checks, mockPlatformEvents: true, realAccountAuthorized: false }, null, 2))
