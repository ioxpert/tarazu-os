import { formatRupees } from '../lib/numfmt'

export type ReminderLang = 'en' | 'hi'

/**
 * A short, polite payment reminder for WhatsApp. Amounts use Indian grouping; the UPI link (if any) is the shop's own
 * payment link for exactly the amount owed. Sent by the shopkeeper from their own phone with a tap, never automatically.
 */
export function buildReminderText(o: { shopName: string; customerName: string; owedPaise: number; upiUri?: string | null; lang?: ReminderLang }): string {
  const amount = formatRupees(o.owedPaise, { paise: 'auto' })
  const lang = o.lang ?? 'en'
  const lines =
    lang === 'hi'
      ? [`नमस्ते ${o.customerName} जी,`, `${o.shopName} में आपका ${amount} बकाया है। कृपया सुविधा से चुका दें।`, ...(o.upiUri ? [`UPI से भुगतान: ${o.upiUri}`] : []), 'धन्यवाद 🙏']
      : [`Hello ${o.customerName},`, `You have ${amount} pending at ${o.shopName}. Please pay when convenient.`, ...(o.upiUri ? [`Pay by UPI: ${o.upiUri}`] : []), 'Thank you 🙏']
  return lines.join('\n')
}

/** What the customer gets after paying: a one-line acknowledgement. */
export function buildThanksText(o: { shopName: string; customerName: string; paidPaise: number; balancePaise: number; lang?: ReminderLang }): string {
  const paid = formatRupees(o.paidPaise, { paise: 'auto' })
  const rest = formatRupees(Math.abs(o.balancePaise), { paise: 'auto' })
  if ((o.lang ?? 'en') === 'hi') {
    const tail = o.balancePaise > 0 ? `अब बाकी ${rest} है।` : o.balancePaise < 0 ? `${rest} आपके पास अग्रिम है।` : 'आपका खाता साफ़ है।'
    return `${o.customerName} जी, ${o.shopName} को ${paid} मिले। ${tail} धन्यवाद 🙏`
  }
  const tail = o.balancePaise > 0 ? `Balance now ${rest}.` : o.balancePaise < 0 ? `You have ${rest} in advance.` : 'Your account is clear.'
  return `${o.customerName}, ${o.shopName} received ${paid}. ${tail} Thank you 🙏`
}
