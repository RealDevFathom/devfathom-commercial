// next/image for the counter screen harness: a plain image, no optimizer.
import type { ComponentProps } from 'react';

export default function FixtureImage({
  unoptimized,
  ...props
}: ComponentProps<'img'> & { unoptimized?: boolean }) {
  void unoptimized;
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...props} alt={props.alt ?? ''} />;
}
