import { expect, test, type Page } from '@playwright/test'
import { goOffline, queuedOps, readyHome, sellFirstResult, sql, typeKeypad, waitForOfflineReady } from './helpers'

async function addLine(page: Page, search: string, qty: string, cost?: string) {
  await page.getByTestId('pu-search').fill(search)
  await page.getByTestId('pu-result').first().click()
  await typeKeypad(page, qty)
  if (cost !== undefined) {
    await page.getByTestId('pu-field-cost').click()
    await typeKeypad(page, cost)
  }
  await page.getByTestId('pu-line-done').click()
}

test.describe('purchase and stock-in', () => {
  test('offline: stock came in from a supplier, part paid, rest owed; then pay the supplier', async ({ page, context }) => {
    await readyHome(page)
    await waitForOfflineReady(page)
    await goOffline(context)

    await page.goto('/#/stock/in')
    await page.getByTestId('supplier-chip').click()
    await page.getByTestId('supplier-search').fill('Agarwal Traders')
    await page.getByTestId('create-supplier').click()
    await expect(page.getByTestId('supplier-chip')).toContainText('Agarwal Traders')
    await page.getByTestId('pu-ref').fill('INV-77')

    await addLine(page, 'parle g', '24', '40')
    await expect(page.getByTestId('pu-line')).toHaveCount(1)
    await expect(page.getByTestId('pu-total')).toHaveText('₹960')

    await page.getByTestId('pu-save').click()
    await expect(page.getByTestId('pn-amount')).toHaveText('₹960') // the full bill is offered
    await typeKeypad(page, '500') // typing replaces it
    await expect(page.getByTestId('pn-owed')).toContainText('₹460')
    await page.getByTestId('pn-confirm').click()

    await expect(page.getByTestId('purchase-saved')).toBeVisible()
    await expect(page.getByTestId('purchase-owed')).toContainText('₹460')
    await expect(page.getByTestId('purchase-row')).toContainText('Agarwal Traders')
    await expect(page.getByTestId('purchase-row')).toContainText('INV-77')

    const ops = await queuedOps(page)
    const types = ops.map((o) => o.entity_type)
    expect(types).toEqual(expect.arrayContaining(['purchase_receipt', 'stock_movement', 'price_version', 'payment', 'khata_entry']))
    const receipt = ops.find((o) => o.entity_type === 'purchase_receipt')!.payload
    expect(receipt).toMatchObject({ totalPaise: 96_000, supplierRef: 'INV-77' })
    expect(receipt.series).toMatch(/^A1B2C3D4-PR-\d{4}-\d{2}$/)
    expect(ops.find((o) => o.entity_type === 'stock_movement')!.payload).toMatchObject({ qtyMilli: 24_000, reason: 'purchase' })
    expect(ops.find((o) => o.entity_type === 'payment')!.payload).toMatchObject({ direction: 'out', mode: 'cash', amountPaise: 50_000 })
    expect(ops.filter((o) => o.entity_type === 'khata_entry').map((o) => o.payload)).toEqual([expect.objectContaining({ direction: 'credit', amountPaise: 46_000 })])
    expect(ops.find((o) => o.entity_type === 'price_version' && o.payload.priceType === 'purchase')!.payload).toMatchObject({ priceType: 'purchase', amountPaise: 4_000 })

    // stock went up
    await page.goto('/#/stock')
    await page.getByTestId('stock-search').fill('parle g')
    await expect(page.getByTestId('stock-row').first()).toContainText('24 packet')

    // supplier payable, then pay part of it
    await page.getByTestId('open-suppliers').click()
    await expect(page.getByTestId('suppliers-total')).toHaveText('₹460')
    await page.getByTestId('supplier-row').click()
    await expect(page.getByTestId('supplier-balance')).toContainText('you owe ₹460')
    await page.getByTestId('i-paid').click()
    await page.getByTestId('pay-upi').click()
    await typeKeypad(page, '100')
    await page.getByTestId('pay-confirm').click()
    await expect(page.getByTestId('supplier-balance')).toContainText('you owe ₹360')
    await expect(page.getByTestId('statement-line')).toHaveCount(2)
  })

  test('market purchase paid in full needs no supplier; selling below cost is warned', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/stock/in')
    await addLine(page, 'parle g', '10', '15') // MRP is 10, cost 15
    await expect(page.getByText('Selling price is below cost')).toBeVisible()
    await page.getByTestId('pu-save').click()
    await page.getByTestId('pn-confirm').click() // paid in full, cash
    await expect(page.getByTestId('purchase-saved')).toBeVisible()
    const ops = await queuedOps(page)
    expect(ops.some((o) => o.entity_type === 'khata_entry')).toBe(false)
    expect(ops.find((o) => o.entity_type === 'purchase_receipt')!.payload.supplierId).toBeNull()
  })

  test('owing without a supplier is refused until one is chosen', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/stock/in')
    await addLine(page, 'parle g', '10', '8')
    await page.getByTestId('pu-save').click()
    await typeKeypad(page, '10')
    await expect(page.getByText('Choose the supplier to keep the rest')).toBeVisible()
    await expect(page.getByTestId('pn-confirm')).toBeDisabled()
  })

  test('count stock: only the difference is written, and a sale before stock was entered shows as short', async ({ page }) => {
    await readyHome(page)
    await sellFirstResult(page) // stock is now -1
    await page.goto('/#/stock/in')
    await addLine(page, 'parle g', '10', '8')
    await page.getByTestId('pu-save').click()
    await page.getByTestId('pn-confirm').click()
    await expect(page.getByTestId('purchase-saved')).toBeVisible()
    await page.goto('/#/stock')
    await page.getByTestId('stock-search').fill('parle g')
    await expect(page.getByTestId('stock-row').first()).toContainText('9 packet') // -1 + 10
    await page.getByTestId('stock-row').first().click()
    await page.getByTestId('count-stock').click()
    await typeKeypad(page, '7')
    await page.getByTestId('stock-save').click()
    await expect(page.getByText('Stock corrected.')).toBeVisible()
    const moves = (await queuedOps(page)).filter((o) => o.entity_type === 'stock_movement').map((o) => [o.payload.qtyMilli, o.payload.reason])
    expect(moves).toEqual([[-1000, 'sale'], [10_000, 'purchase'], [-2000, 'adjustment']])
    const [{ q }] = await sql<{ q: number }>(page, 'SELECT qty_milli AS q FROM stock_balance')
    expect(q).toBe(7_000)
  })

  test('Hindi stock-in and 48 dp targets', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/settings')
    await page.getByTestId('lang-hi').click()
    await page.goto('/#/stock')
    await expect(page.getByTestId('stock-in')).toContainText('स्टॉक आया')
    const small: string[] = []
    for (const r of ['/#/stock', '/#/stock/in', '/#/stock/suppliers', '/#/stock/purchases']) {
      await page.goto(r)
      await page.waitForTimeout(300)
      const boxes = await page.locator('button:visible, input:visible').evaluateAll((els) =>
        els.map((el) => ({ n: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24), w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })).filter((b) => b.w < 47.5 || b.h < 47.5),
      )
      for (const b of boxes) small.push(`${r} ${b.n} ${Math.round(b.w)}x${Math.round(b.h)}`)
    }
    expect(small).toEqual([])
  })
})
