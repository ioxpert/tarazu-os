import { expect, test } from '@playwright/test'
import { goOffline, opTypes, queuedOps, readyHome, sql, typeKeypad, waitForOfflineReady } from './helpers'

async function addCustomer(page: import('@playwright/test').Page, name: string, phone = '', owes = '') {
  await page.goto('/#/khata/new')
  await page.getByTestId('kn-name').fill(name)
  if (phone) await page.getByTestId('kn-phone').fill(phone)
  if (owes) await page.getByTestId('kn-owed').fill(owes)
  await page.getByTestId('kn-save').click()
  await expect(page.getByTestId('customer-screen')).toBeVisible()
}

test.describe('khata', () => {
  test('offline: add a customer with an old balance, take part payment, see the statement', async ({ page, context }) => {
    await readyHome(page)
    await waitForOfflineReady(page)
    await goOffline(context)

    await addCustomer(page, 'Ramesh', '98765 43210', '1500')
    await expect(page.getByTestId('customer-balance')).toContainText('₹1,500')

    await page.getByTestId('customer-paid').click()
    await expect(page.getByTestId('pay-amount')).toHaveText('₹1500') // the full amount is offered
    await typeKeypad(page, '500') // typing replaces it
    await expect(page.getByTestId('pay-amount')).toHaveText('₹500')
    await page.getByTestId('pay-confirm').click()
    await expect(page.getByTestId('paid-saved')).toBeVisible()
    await expect(page.getByTestId('customer-balance')).toContainText('₹1,000')

    const lines = page.getByTestId('statement-line')
    await expect(lines).toHaveCount(2)
    await expect(lines.first()).toContainText('Paid')
    await expect(lines.first()).toContainText('owes ₹1,000 after')
    await expect(lines.last()).toContainText('Earlier balance')

    const ops = await queuedOps(page)
    const pay = ops.find((o) => o.entity_type === 'payment')!
    expect(pay.payload).toMatchObject({ direction: 'in', mode: 'cash', amountPaise: 50_000, invoiceId: null })
    expect(ops.filter((o) => o.entity_type === 'khata_entry').map((o) => o.payload.direction)).toEqual(['debit', 'credit'])
    expect(ops.find((o) => o.entity_type === 'party' && o.op_type === 'update')!.payload).toMatchObject({ phone: '9876543210' })

    await page.goto('/#/khata')
    await expect(page.getByTestId('khata-total')).toHaveText('₹1,000')
    await expect(page.getByTestId('khata-row')).toContainText('Ramesh')
  })

  test('a credit sale appears on the statement and "customer paid" clears it', async ({ page }) => {
    await readyHome(page)
    await page.goto('/#/bill')
    await page.getByTestId('item-search').fill('parle g')
    await page.getByTestId('item-card').first().click()
    await page.getByTestId('customer-chip').click()
    await page.getByTestId('customer-search').fill('Mohan')
    await page.getByTestId('create-customer').click()
    await page.getByTestId('pay').click()
    await page.getByTestId('mode-credit').click()
    await page.getByTestId('complete-sale').click()
    await expect(page.getByTestId('receipt-owes')).toBeVisible()

    const [{ id }] = await sql<{ id: string }>(page, "SELECT id FROM party WHERE name = 'Mohan'")
    await page.goto(`/#/khata/c/${id}`)
    await expect(page.getByTestId('statement-line')).toHaveCount(1)
    await expect(page.getByTestId('statement-line')).toContainText('Bill')
    const owed = (await page.getByTestId('customer-balance').textContent())!
    await page.getByTestId('customer-paid').click()
    await page.getByTestId('pay-upi').click()
    await page.getByTestId('pay-confirm').click() // the whole amount is offered
    await expect(page.getByTestId('customer-balance')).toHaveText('Clear')
    expect(owed).toMatch(/owes/)
    await expect(page.getByTestId('statement-line')).toHaveCount(2)
  })

  test('paying more than owed is kept as an advance', async ({ page }) => {
    await readyHome(page)
    await addCustomer(page, 'Geeta', '', '100')
    await page.getByTestId('customer-paid').click()
    await typeKeypad(page, '250')
    await expect(page.getByText(/more than they owe/)).toBeVisible()
    await page.getByTestId('pay-confirm').click()
    await expect(page.getByTestId('customer-balance')).toContainText('advance ₹150')
    await page.goto('/#/khata')
    await page.getByTestId('khata-filter-advance').click()
    await expect(page.getByTestId('khata-row')).toContainText('Geeta')
  })

  test('credit limit warns while billing but never blocks the sale', async ({ page }) => {
    await readyHome(page)
    await addCustomer(page, 'Vikram', '', '495')
    await page.getByTestId('edit-customer').click()
    await page.getByTestId('ec-limit').fill('500')
    await page.getByTestId('ec-save').click()
    await expect(page.getByText('Credit limit ₹500')).toBeVisible()

    await page.goto('/#/bill')
    await page.getByTestId('item-search').fill('parle g')
    await page.getByTestId('item-card').first().click()
    await page.getByTestId('customer-chip').click()
    await page.getByTestId('customer-search').fill('Vikram')
    await page.getByRole('button', { name: /Vikram/ }).first().click()
    await page.getByTestId('pay').click()
    await page.getByTestId('mode-credit').click()
    await expect(page.getByTestId('credit-limit-warning')).toContainText('above the limit of ₹500')
    await page.getByTestId('complete-sale').click()
    await expect(page.getByTestId('sale-saved')).toBeVisible() // still billed
  })

  test('reminders need the customer\'s yes; offline they are queued; withdrawing stops them', async ({ page, context }) => {
    await readyHome(page)
    await addCustomer(page, 'Sunita', '9811122233', '2500')
    await waitForOfflineReady(page)
    await goOffline(context)

    await page.getByTestId('remind').click()
    await expect(page.getByTestId('remind-send')).toHaveCount(0) // nothing is pre-ticked
    await expect(page.getByTestId('consent-save')).toBeDisabled()
    await page.getByTestId('consent-tick').check()
    await page.getByTestId('consent-save').click()
    await expect(page.getByText('Hello Sunita')).toBeVisible()
    await expect(page.getByText(/₹2,500 pending/)).toBeVisible()
    await page.getByTestId('remind-send').click()
    await expect(page.getByText(/Saved\. You will be asked to send it/)).toBeVisible()

    const queued = await sql<{ body: string; phone: string }>(page, 'SELECT body, phone FROM share_queue WHERE sent_at IS NULL')
    expect(queued).toHaveLength(1)
    expect(queued[0].phone).toBe('919811122233')
    const consent = await sql<{ action: string; purpose: string; channel: string; sent_at: string | null }>(page, 'SELECT action, purpose, channel, sent_at FROM consent_outbox')
    expect(consent).toEqual([{ action: 'grant', purpose: 'whatsapp_reminders', channel: 'verbal', sent_at: null }])

    await page.getByTestId('consent-withdraw').click()
    await expect(page.getByTestId('remind-send')).toHaveCount(0)
    await expect(page.getByTestId('consent-save')).toBeVisible()
    expect((await sql(page, 'SELECT action FROM consent_outbox ORDER BY occurred_at')).map((r) => (r as { action: string }).action)).toEqual(['grant', 'withdraw'])
    expect((await opTypes(page)).includes('payment')).toBe(false)
  })

  test('Hindi khata and 48 dp targets', async ({ page }) => {
    await readyHome(page)
    await addCustomer(page, 'Anil', '', '300')
    await page.goto('/#/settings')
    await page.getByTestId('lang-hi').click()
    await page.goto('/#/khata')
    await expect(page.getByTestId('khata-add')).toContainText('ग्राहक जोड़ें')
    await expect(page.getByTestId('khata-row')).toContainText('₹300 बकाया')
    const small = await page.locator('button:visible, input:visible').evaluateAll((els) =>
      els.map((el) => ({ n: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24), w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height })).filter((b) => b.w < 47.5 || b.h < 47.5),
    )
    expect(small).toEqual([])
  })
})
