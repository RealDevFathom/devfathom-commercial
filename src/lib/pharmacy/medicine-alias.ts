/** A name must include an Arabic-script letter, rather than only digits or elongation marks. */
export function isUrduMedicineName(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value.trim().length <= 300 &&
    [...value].some(
      (letter) =>
        letter !== '\u0640' && /\p{Script_Extensions=Arabic}/u.test(letter) && /\p{L}/u.test(letter)
    )
  );
}
