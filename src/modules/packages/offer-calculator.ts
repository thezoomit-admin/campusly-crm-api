export type DiscountKind = 'AMOUNT' | 'PERCENTAGE'

export type CalculatorDiscount = { type: DiscountKind; value: number } | null

export type CalculatorLine = {
  /** Package included lines are covered by the package price and never add to the totals. */
  countsTowardTotal: boolean
  price: number
  quantity: number
  discount: CalculatorDiscount
}

export type CalculatorInput = {
  packagePrice: number | null
  lines: CalculatorLine[]
  fileOpeningCharge: number
  overallDiscount: CalculatorDiscount
}

export type CalculatedLine = {
  gross: number
  discountAmount: number
  lineTotal: number
  discountExceedsTotal: boolean
}

export type CalculatedOffer = {
  lines: CalculatedLine[]
  grossTotal: number
  lineDiscountTotal: number
  subtotal: number
  overallDiscountAmount: number
  overallDiscountExceedsSubtotal: boolean
  finalPayable: number
  discountPercentOfGross: number
}

function toPaisa(value: number) {
  return Math.round(value * 100)
}

function fromPaisa(value: number) {
  return value / 100
}

function discountPaisa(basePaisa: number, discount: CalculatorDiscount) {
  if (!discount || !(discount.value > 0)) return 0
  if (discount.type === 'PERCENTAGE') return Math.round((basePaisa * discount.value) / 100)
  return toPaisa(discount.value)
}

/**
 * Gross = package price + every counted line (price × qty) + file opening charge.
 * Subtotal = gross − line item discounts. Final payable = subtotal − overall discount.
 */
export function calculateOffer(input: CalculatorInput): CalculatedOffer {
  let grossPaisa = toPaisa(input.packagePrice ?? 0) + toPaisa(input.fileOpeningCharge)
  let lineDiscountPaisa = 0

  const lines = input.lines.map((line) => {
    if (!line.countsTowardTotal) {
      return { gross: 0, discountAmount: 0, lineTotal: 0, discountExceedsTotal: false }
    }
    const gross = toPaisa(line.price) * Math.max(0, Math.trunc(line.quantity))
    const requested = discountPaisa(gross, line.discount)
    const discountExceedsTotal = requested > gross
    const applied = Math.min(requested, gross)
    grossPaisa += gross
    lineDiscountPaisa += applied
    return {
      gross: fromPaisa(gross),
      discountAmount: fromPaisa(applied),
      lineTotal: fromPaisa(gross - applied),
      discountExceedsTotal,
    }
  })

  const subtotalPaisa = grossPaisa - lineDiscountPaisa
  const requestedOverall = discountPaisa(subtotalPaisa, input.overallDiscount)
  const overallDiscountExceedsSubtotal = requestedOverall > subtotalPaisa
  const overallPaisa = Math.min(requestedOverall, subtotalPaisa)
  const finalPaisa = subtotalPaisa - overallPaisa
  const totalDiscountPaisa = lineDiscountPaisa + overallPaisa

  return {
    lines,
    grossTotal: fromPaisa(grossPaisa),
    lineDiscountTotal: fromPaisa(lineDiscountPaisa),
    subtotal: fromPaisa(subtotalPaisa),
    overallDiscountAmount: fromPaisa(overallPaisa),
    overallDiscountExceedsSubtotal,
    finalPayable: fromPaisa(finalPaisa),
    discountPercentOfGross: grossPaisa > 0 ? (totalDiscountPaisa / grossPaisa) * 100 : 0,
  }
}
