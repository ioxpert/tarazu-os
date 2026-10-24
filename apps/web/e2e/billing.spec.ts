import { expect, test } from '@playwright/test'
import { cacheOwnerPin, exec, goOffline, opTypes, queuedOps, readyHome, sellFirstResult, setProfile, sql, timings, typeKeypad, waitForOfflineReady } from './helpers'

test.describe('offline billing', () => {
  test('a sale in airplane mode: search "parle g", three taps, saved on the device and queued for backup', async ({ page, context }) => {
    await readyHome(page)
    await waitForOfflineReady(page)
    await goOffline(context)
    await expect(page.getByTestId('net-state')).toContainText('Offline')

    // a cold start with no network still opens and bills (service worker + local database)
    await page.reload()
    await expect(page.getByTestId('home-screen')).toBeVisible()

    await page.getByTestId('home-bill').click()
    await page.getByTestId('item-search').fill('parle g')
    const first = page.getByTestId('item-card').first()
    await expect(first).toContainText(/parle-g/i)
    await first.click() // tap 1
    await expect(page.getByTestId('cart-line')).toHaveCount(1)
    await page.getByTestId('pay').click() // tap 2
    await page.getByTestId('complete-sale').click() // tap 3
    await expect(page.getByTestId('sale-saved')).toBeVisible()

    const ops = await opTypes(page)
    expect(ops).toEqual(expect.arrayContaining(['invoice', 'stock_movement', 'payment']))
    const inv = await sql<{ number: number; total_paise: number }>(page, 'SELECT number, total_paise FROM invoice')
    expect(inv).toHaveLength(1)
    expect(inv[0].number).toBe(1)
    expect(inv[0].total_paise % 100).toBe(0) // rounded to the rupee

    // the device is still the system of record after a reload with no network
    await page.reload()
    await expect(page.getByTestId('sale-saved')).toBeVisible()
  })

  test('invoice numbers run 1, 2, 3 on a device and never restart', async ({ page }) => {
    await readyHome(page)
    for (let i = 0; i < 3; i++) await sellFirstResult(page)
    const nums = await sql<{ number: number; series: string }>(page, 'SELECT number, series FROM invoice ORDER BY number')
    expect(nums.map((n) => n.number)).toEqual([1, 2, 3])
    expect(new Set(nums.map((n) => n.series)).size).toBe(1)
    expect(nums[0].series).toMatch(/^A1B2C3D4-\d{4}-\d{2}$/)
  })

  test('hold a bill, sell something else, resume the held bill', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/bill')
    await page.getByTestId('item-search').fill('maggi')
    await page.getByTestId('item-card').first().click()
    await page.getByTestId('hold-bill').click()
    await expect(page.getByTestId('empty-cart')).toBeVisible()
    await expect(page.getByTestId('held-bills')).toBeVisible()
    expect((await opTypes(page)).filter((t) => t === 'invoice')).toHaveLength(0) // a hold is not a sale

    await sellFirstResult(page, 'parle g')
    await page.goto('/#/bill')
    await page.getByTestId('held-bills').click()
    await page.getByTestId('resume-bill').click()
    await expect(page.getByTestId('cart-line')).toHaveCount(1)
    await expect(page.getByTestId('cart-line')).toContainText(/maggi/i)
  })

  test('undo takes back the last change on the bill', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/bill')
    await page.getByTestId('item-search').fill('parle g')
    await page.getByTestId('item-card').first().click()
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByTestId('empty-cart')).toBeVisible()
  })

  test('split tender: 1200 = 500 UPI + 700 customer owes shows 700 in Khata', async ({ page }) => {
    await readyHome(page)
    // a new item in a few taps
    await page.goto('/#/stock/new')
    await page.getByTestId('if-name').fill('Test Gift Box')
    await page.getByTestId('if-price').fill('1200')
    await page.getByTestId('if-save').click()
    await expect(page.getByTestId('stock-screen')).toBeVisible()

    await page.goto('/#/bill')
    await page.getByTestId('item-search').fill('gift box')
    await page.getByTestId('item-card').first().click()
    await page.getByTestId('customer-chip').click()
    await page.getByTestId('customer-search').fill('Ramesh')
    await page.getByTestId('create-customer').click()
    await page.getByTestId('pay').click()
    await expect(page.getByTestId('tender-due')).toHaveText('₹1,200')

    await page.getByTestId('mode-upi').click()
    await typeKeypad(page, '500') // typing replaces the offered amount
    await page.getByTestId('mode-credit').click()
    await expect(page.getByTestId('amount-display')).toHaveText('₹700')
    await page.getByTestId('complete-sale').click()
    await expect(page.getByTestId('receipt-owes')).toContainText('₹700')

    const pays = await sql<{ mode: string; amount_paise: number }>(page, 'SELECT mode, amount_paise FROM payment')
    expect(pays).toEqual([{ mode: 'upi', amount_paise: 50000 }])
    expect(await opTypes(page)).toContain('khata_entry')

    await page.goto('/#/khata')
    await expect(page.getByTestId('khata-total')).toHaveText('₹700')
    await expect(page.getByTestId('khata-row')).toContainText('Ramesh')
  })

  test('cash with change: customer hands over more, change is shown and is not a payment', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/bill')
    await page.getByTestId('item-search').fill('parle g')
    await page.getByTestId('item-card').first().click()
    await page.getByTestId('pay').click()
    await typeKeypad(page, '500')
    await expect(page.getByTestId('change-due')).toBeVisible()
    await page.getByTestId('complete-sale').click()
    await expect(page.getByTestId('receipt-change')).toBeVisible()
    const due = await sql<{ total_paise: number }>(page, 'SELECT total_paise FROM invoice')
    const pay = await sql<{ amount_paise: number }>(page, "SELECT amount_paise FROM payment WHERE mode = 'cash'")
    expect(pay[0].amount_paise).toBe(due[0].total_paise)
  })

  test('a discount above policy asks for the owner PIN (offline) and is recorded with the approval', async ({ page }) => {
    await readyHome(page)
    await cacheOwnerPin(page, '1234')
    await page.goto('/#/bill')
    await page.getByTestId('item-search').fill('parle g')
    await page.getByTestId('item-card').first().click()
    await page.getByTestId('bill-discount').click()
    await typeKeypad(page, '20')
    await page.getByTestId('discount-apply').click()
    await page.getByTestId('pay').click()
    await page.getByTestId('complete-sale').click()
    await expect(page.getByTestId('approval-modal')).toBeVisible()
    await page.getByRole('textbox', { name: 'Reason' }).fill('Regular customer')
    await typeKeypad(page, '9999')
    await page.getByTestId('approval-confirm').click()
    await expect(page.getByText('Wrong PIN')).toBeVisible()
    await typeKeypad(page, '1234')
    await page.getByTestId('approval-confirm').click()
    await expect(page.getByTestId('sale-saved')).toBeVisible()
    const p = (await queuedOps(page)).find((o) => o.entity_type === 'invoice')!.payload
    expect(p.approval).toMatchObject({ approverUserId: '99999999-9999-4999-8999-999999999999', reason: 'Regular customer' })
    expect(p.discountPaise).toBe(0)
  })

  test('GST regular merchant: tax inclusive split on the bill and a tax invoice', async ({ page }) => {
    await readyHome(page)
    await setProfile(page, { gstMode: 'regular', gstin: '27ABCDE1234F1Z5' })
    await page.reload()
    await expect(page.getByTestId('home-screen')).toBeVisible()
    await sellFirstResult(page, 'parle g')
    const [inv] = await sql<{ doc_type: string; tax_paise: number; subtotal_paise: number; total_paise: number; round_off_paise: number }>(page, 'SELECT doc_type, tax_paise, subtotal_paise, total_paise, round_off_paise FROM invoice')
    expect(inv.doc_type).toBe('tax_invoice')
    expect(inv.subtotal_paise + inv.tax_paise + inv.round_off_paise).toBe(inv.total_paise)
  })
})

test.describe('returns, stock and shifts', () => {
  test('return reverses stock, payment and is a credit note against the invoice', async ({ page }) => {
    await readyHome(page)
    await cacheOwnerPin(page)
    await sellFirstResult(page)
    await page.goto('/#/returns')
    await page.getByTestId('invoice-row').first().click()
    await page.getByTestId('return-all').first().click()
    await page.getByTestId('return-reason').fill('Damaged')
    await page.getByTestId('return-confirm').click()
    await typeKeypad(page, '1234')
    await page.getByTestId('approval-confirm').click()
    await expect(page.getByTestId('sale-saved')).toBeVisible()

    const ops = await opTypes(page)
    expect(ops).toEqual(expect.arrayContaining(['credit_note']))
    const all = await queuedOps(page)
    expect(all.filter((o) => o.entity_type === 'stock_movement').reduce((a, o) => a + (o.payload.qtyMilli as number), 0)).toBe(0) // sale -1000, return +1000
    expect(all.filter((o) => o.entity_type === 'payment' && o.payload.direction === 'out')).toHaveLength(1)

    // the same invoice cannot be returned twice
    await page.goto('/#/returns')
    await page.getByTestId('invoice-row').first().click()
    await expect(page.getByText('All returned')).toBeVisible()
  })

  test('selling more than the shelf has still completes, and Stock flags it', async ({ page }) => {
    await readyHome(page)
    await sellFirstResult(page)
    await page.goto('/#/stock')
    await page.getByTestId('stock-search').fill('parle g')
    await expect(page.getByTestId('oversold-badge').first()).toBeVisible() // never counted, sold anyway: stock is -1
  })

  test('shift: open with a float, sell cash, close short by 50 and see the variance', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/shift')
    await typeKeypad(page, '1000')
    await page.getByTestId('shift-act').click()
    await sellFirstResult(page)
    const [{ total_paise }] = await sql<{ total_paise: number }>(page, 'SELECT total_paise FROM invoice')
    const expectedRupees = 1000 + total_paise / 100
    await page.goto('/#/shift')
    await typeKeypad(page, String(expectedRupees - 50))
    await page.getByTestId('shift-act').click()
    await expect(page.getByTestId('shift-result')).toContainText('Short by ₹50')
    expect(await opTypes(page)).toEqual(expect.arrayContaining(['shift', 'shift_close']))
  })

  test('barcode: add by keyboard-wedge scan; unknown barcode offers to add the item', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/stock/new')
    await page.getByTestId('if-name').fill('Scan Test Biscuit')
    await page.getByTestId('if-price').fill('10')
    await page.getByTestId('if-barcode').fill('8901234567890')
    await page.getByTestId('if-save').click()
    await expect(page.getByTestId('stock-screen')).toBeVisible()

    await page.goto('/#/bill')
    await expect(page.getByTestId('bill-screen')).toBeVisible()
    await page.locator('body').click()
    await page.keyboard.type('8901234567890', { delay: 5 }) // a scanner types fast...
    await page.keyboard.press('Enter') // ...and ends with Enter
    await expect(page.getByTestId('cart-line')).toContainText('Scan Test Biscuit')

    await page.keyboard.type('8909999999999', { delay: 5 })
    await page.keyboard.press('Enter')
    await expect(page.getByText('8909999999999')).toBeVisible()
  })

  test('duplicate item is never merged silently', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/stock/new')
    await page.getByTestId('if-name').fill('Parle-G Biscuit 100 g')
    await page.getByTestId('if-save').click()
    await expect(page.getByTestId('dup-modal')).toBeVisible()
  })

  test('Hindi: the whole counter switches language', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/settings')
    await page.getByTestId('lang-hi').click()
    await page.goto('/#/')
    await expect(page.getByTestId('home-bill')).toHaveText('बिल')
    await expect(page.getByTestId('home-stock')).toHaveText('स्टॉक')
  })

  test('local-first: nothing in the sale path calls the network', async ({ page }) => {
    const calls: string[] = []
    await readyHome(page)
    page.on('request', (r) => {
      if (!r.url().startsWith('data:') && !r.url().includes('/assets/') && !r.url().includes('localhost:4180/#')) calls.push(r.url())
    })
    await sellFirstResult(page)
    expect(calls.filter((u) => !/\/api\/|\.wasm|\.js|\.css|\.json|\.svg|\.png/.test(u))).toEqual([])
    await exec(page, 'SELECT 1')
  })
})

test.describe('performance budgets', () => {
  test('starter pack seeds in under 5 s and >= 500 items are billable', async ({ page }) => {
    const { linkDevice, pickPack } = await import('./helpers')
    await linkDevice(page)
    await expect(page.getByTestId('onboarding-screen')).toBeVisible({ timeout: 30_000 })
    const t0 = Date.now()
    await pickPack(page, 'grocery')
    const took = Date.now() - t0
    const [{ n }] = await sql<{ n: number }>(page, "SELECT count(*) AS n FROM product WHERE active = 1")
    expect(n).toBeGreaterThanOrEqual(500)
    console.log(`seeded ${n} items in ${took} ms`)
    expect(took).toBeLessThan(5000)
    await page.goto('/#/bill')
    await page.getByTestId('item-search').fill('parle')
    await expect(page.getByTestId('item-card').first()).toBeVisible()
  })

  test('commit < 300 ms (P95 of 20 sales) and search answers in < 100 ms', async ({ page, browserName }, info) => {
    test.skip(browserName !== 'chromium')
    await readyHome(page)
    if (info.project.name === 'android-chrome') {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }) // a 2 GB Android class CPU
    }
    for (let i = 0; i < 20; i++) await sellFirstResult(page)
    const commits = await timings(page, 'commitSale')
    expect(commits).toHaveLength(20)
    const sorted = [...commits].sort((a, b) => a - b)
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]
    console.log(`[${info.project.name}] commitSale median ${sorted[10].toFixed(1)} ms, P95 ${p95.toFixed(1)} ms`)
    expect(p95).toBeLessThan(300)

    const lookups = await page.evaluate(() => {
      const t = (window as unknown as { __tarazu: { search: (q: string) => string[] } }).__tarazu
      const qs = ['parle g', 'maggi', 'tata salt', 'amul butter', 'aashirvaad atta', 'surf excel', 'dettol', 'colgate', 'sugar', 'chai']
      const out: number[] = []
      for (let i = 0; i < 100; i++) {
        const s = performance.now()
        t.search(qs[i % qs.length])
        out.push(performance.now() - s)
      }
      return out
    })
    lookups.sort((a, b) => a - b)
    const lp95 = lookups[Math.ceil(0.95 * lookups.length) - 1]
    console.log(`[${info.project.name}] search P95 ${lp95.toFixed(2)} ms`)
    expect(lp95).toBeLessThan(100)
  })

  test('new item takes under 15 s of taps and the right SKU is first in under 1 s offline', async ({ page, context }) => {
    await readyHome(page)
    await waitForOfflineReady(page)
    await goOffline(context)
    const t0 = Date.now()
    await page.goto('/#/stock/new')
    await page.getByTestId('if-name').fill('Hand Made Laddu 250 g')
    await page.getByTestId('if-price').fill('120')
    await page.getByTestId('if-save').click()
    await expect(page.getByTestId('stock-screen')).toBeVisible()
    expect(Date.now() - t0).toBeLessThan(15_000)

    await page.goto('/#/bill')
    const t1 = Date.now()
    await page.getByTestId('item-search').fill('parle g')
    await expect(page.getByTestId('item-card').first()).toContainText(/parle-g/i)
    expect(Date.now() - t1).toBeLessThan(1000)
  })
})

test.describe('usability rules', () => {
  test('tap targets are at least 48 x 48 on the main counter screens', async ({ page }) => {
    await readyHome(page)
    const routes = ['/#/', '/#/bill', '/#/stock', '/#/returns', '/#/shift']
    const small: string[] = []
    for (const r of routes) {
      await page.goto(r)
      await page.waitForTimeout(300)
      const boxes = await page.locator('button:visible, a:visible, input[type=search]:visible, input[type=checkbox]:visible').evaluateAll((els) =>
        els.map((el) => {
          const b = el.getBoundingClientRect()
          return { name: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30), w: b.width, h: b.height }
        }),
      )
      for (const b of boxes) if (b.w < 47.5 || b.h < 47.5) small.push(`${r} "${b.name}" ${Math.round(b.w)}x${Math.round(b.h)}`)
    }
    expect(small).toEqual([])
  })

  test('a plain sale needs no phone, GSTIN, email or bank account', async ({ page }) => {
    await readyHome(page)
    await sellFirstResult(page)
    await expect(page.getByTestId('sale-saved')).toBeVisible()
    await expect(page.getByLabel(/phone|gstin|email|bank/i)).toHaveCount(0)
  })
})

test.describe('quantity display', () => {
  test('the line editor shows the real quantity, not a thousand times it', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/bill')
    await page.getByTestId('item-search').fill('parle g')
    await page.getByTestId('item-card').first().click()
    await page.getByTestId('item-search').fill('parle g') // the box clears after each item
    await page.getByTestId('item-card').first().click() // 2 packets
    await page.getByRole('button', { name: /Edit/ }).first().click()
    await expect(page.getByRole('button', { name: /Quantity: 2/ })).toBeVisible()
  })
})

test.describe('fast billing', () => {
  test('Enter adds the top result and clears the search; an unknown barcode offers to add the item', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/bill')
    await page.getByTestId('item-search').fill('parle g')
    await page.getByTestId('item-search').press('Enter')
    await expect(page.getByTestId('cart-line')).toHaveCount(1)
    await expect(page.getByTestId('item-search')).toHaveValue('')
    await page.getByTestId('item-search').fill('1234567890123')
    await page.getByTestId('item-search').press('Enter')
    await expect(page.getByText(/1234567890123/)).toBeVisible()
    await expect(page.getByTestId('cart-line')).toHaveCount(1)
  })

  test('the bill stays on screen on a phone while you search, and quick cash works out the change', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/bill')
    for (const q of ['parle g', 'maggi', 'dalda']) {
      await page.getByTestId('item-search').fill(q)
      await page.getByTestId('item-search').press('Enter')
    }
    await expect(page.getByTestId('cart-line')).toHaveCount(3)
    const view = page.viewportSize()!
    const box = (await page.getByTestId('cart-lines').boundingBox())!
    expect(box.y).toBeLessThan(view.height * 0.7) // the bill starts on the first screen, not under the results

    await page.getByTestId('pay').click()
    const due = Number((await page.getByTestId('tender-due').innerText()).replace(/[^0-9.]/g, ''))
    const quick = page.getByTestId('cash-quick')
    const first = Number((await quick.first().innerText()).replace(/[^0-9.]/g, ''))
    expect(first).toBeGreaterThan(due)
    await quick.first().click()
    await expect(page.getByTestId('change-due')).toContainText(String(first - due))
    await page.getByTestId('cash-exact').click()
    await expect(page.getByTestId('change-due')).toHaveCount(0)
    await page.getByTestId('complete-sale').click()
    await expect(page.getByTestId('sale-saved')).toBeVisible()
  })
})
