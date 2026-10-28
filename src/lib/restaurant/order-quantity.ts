/** Maximum number of physical units represented by one restaurant order line. */
export const MAX_ORDER_ITEM_QUANTITY = 100;

export function isValidOrderItemQuantity(quantity: number): boolean {
  return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= MAX_ORDER_ITEM_QUANTITY;
}
