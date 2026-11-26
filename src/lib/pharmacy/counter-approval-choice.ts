/** Only server-derived, branch-eligible staff profile IDs may be returned for a collision. */
export class CounterApprovalChoice extends Error {
  constructor(
    readonly staffProfileIds: string[],
    readonly choiceProofs: string[]
  ) {
    super(
      'Which person is approving? Choose their name and wait for their next authenticator code, then enter it.'
    );
  }
}
