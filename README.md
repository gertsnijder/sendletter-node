# sendletter

Send a real letter — printed, folded, franked and handed to the post — from Node.

```bash
npm install sendletter
```

```ts
import { SendLetter } from 'sendletter'

const sendletter = new SendLetter(process.env.SENDLETTER_API_KEY!)

const letter = await sendletter.send({
  sender: {
    company: 'Twilper',
    name: 'Gert Snijder',
    street: 'Merelstraat',
    number: '64',
    postalCode: '8916 AX',
    city: 'Leeuwarden',
    country: 'NL',
  },
  recipient: {
    name: 'Jan de Vries',
    street: 'Keizersgracht',
    number: '123',
    postalCode: '1015 CJ',
    city: 'Amsterdam',
    country: 'NL',
  },
  text: 'Beste heer De Vries,\n\nBijgaand de herinnering voor factuur 2026-0042.',
})

console.log(letter.id, letter.status, letter.totalCents)
```

Get a key at [sendletter.eu](https://sendletter.eu/en/developers). Keys starting
`sk_test_` post nothing, charge nothing, and still run the whole status chain, so
you can build against the real thing.

## Sending

Give the content exactly one way: `text`, `document` (rich text), `file`
(base64) or `fileUrl`. Two is refused rather than guessed at, because the wrong
document in a postbox cannot be recalled.

```ts
// An invoice you already have as a PDF.
await sendletter.send({
  sender,
  recipient,
  file: { name: 'invoice.pdf', contentBase64: pdf.toString('base64') },
  product: 'registered',        // 'standard' | 'priority' | 'registered'
  colour: true,
  idempotencyKey: `invoice-${invoice.id}`,
})
```

**Send an `idempotencyKey` on anything that can be retried.** A repeat with the
same key returns the original letter instead of a second envelope. That single
field is what makes a retry after a network timeout safe, and a timeout says
nothing about whether the letter was accepted.

## Reading

```ts
await sendletter.get(id)                       // one letter
await sendletter.list({ status: 'posted' })    // one page
await sendletter.cancel(id, 'order withdrawn') // while it is still cancellable
await sendletter.download(id)                  // the PDF as printed
await sendletter.download(id, { proof: true }) // proof of posting

for await (const letter of sendletter.all({ mode: 'live' })) {
  // walks every page; you never hold the cursor
}
```

## Checking before you spend

```ts
const check = await sendletter.validateAddress(recipient)
if (!check.valid) console.log(check.problems)   // answers, does not throw

const quote = await sendletter.quote({ destination: 'DE', pages: 3 })
```

`validateAddress` returns a bad address rather than throwing: a wrong postcode
is the successful outcome of asking. `supported: false` is the one that cannot
be fixed by editing the address — we do not carry to that country.

## Errors

Everything the API refuses becomes a `SendLetterError` with a `code` to branch
on.

```ts
import { SendLetterError } from 'sendletter'

try {
  await sendletter.send({ sender, recipient, text })
} catch (error) {
  if (!(error instanceof SendLetterError)) throw error

  if (error.code === 'insufficient_balance') {
    // Put this in front of the customer; the wallet is short, nothing else.
    return redirect(error.topUpUrl!)
  }
  if (error.isRetryable) {
    await sleep((error.retryAfter ?? 5) * 1000)
  }
}
```

`isRetryable` covers 429 and 5xx. Nothing else should be retried: a 400 means
the letter will be refused just as firmly the second time.

## Webhooks

Status changes arrive as a POST to the URL you registered. **Verify them.**
Without that, anyone who learns your endpoint can tell your system a letter was
delivered.

```ts
import { verifyWebhook, SendLetterError } from 'sendletter'

export async function POST(request: Request) {
  const rawBody = await request.text()   // the raw text, not the parsed object

  let event
  try {
    event = verifyWebhook({
      rawBody,
      signature: request.headers.get('x-sendletter-signature'),
      secret: process.env.SENDLETTER_WEBHOOK_SECRET!,
    })
  } catch (error) {
    if (error instanceof SendLetterError) return new Response('nope', { status: 400 })
    throw error
  }

  if (await alreadyHandled(event.id)) return new Response('ok')   // see below
  await handle(event)                                            // letter.posted, ...
  return new Response('ok')
}
```

Two things this shape gets right and hand-rolled verification usually does not:

- **The raw body, not a re-serialised one.** The signature covers the exact
  bytes we sent, and `JSON.stringify` does not promise to reproduce them. Read
  the body as text, verify, then parse.
- **Deduplicate on `event.id`.** Delivery is at-least-once with retries, so a
  timeout on your side means the same event arrives again. `letter.posted`
  handled twice should not bill a customer twice.

Events: `letter.submitted`, `letter.printed`, `letter.posted`,
`letter.delivered`, `letter.failed`, `letter.refunded`.

## Test mode

A `sk_test_` key runs the full chain — `submitted → printed → posted →
delivered` — with webhooks firing exactly as they will in production, while
touching no wallet and no printer. `client.isTestMode` tells you which kind of
key you are holding, which is worth asserting in a deploy check: the two look
alike in a log and only one of them costs money.

## Reference

[sendletter.eu/en/developers](https://sendletter.eu/en/developers) ·
OpenAPI at `/api/v1/openapi.json` · MIT
