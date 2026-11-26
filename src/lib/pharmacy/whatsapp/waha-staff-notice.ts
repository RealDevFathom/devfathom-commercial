export function deliveryNotice(outcome: string | null) {
  switch (outcome) {
    case 'NOT_ON_WHATSAPP':
      return 'A recipient is not on WhatsApp. Check the message log for an authorized SMS fallback or arrange another way to provide the receipt or reminder.';
    case 'UNAVAILABLE':
    case 'DISCONNECTED':
      return 'WhatsApp is disconnected. Sales and receipts can continue. Check the message log for any outstanding delivery.';
    case 'UNKNOWN':
      return 'A WhatsApp delivery is unconfirmed. Check the message log before trying another channel.';
    case 'RESTRICTED':
      return 'WhatsApp has restricted the pharmacy number. Sending is paused. Tell the owner.';
    default:
      return null;
  }
}
