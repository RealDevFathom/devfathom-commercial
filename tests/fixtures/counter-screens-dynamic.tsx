// next/dynamic for the counter screen harness: lazily loaded panels (the assistant, the
// command palette) stay unloaded, as they are until first opened in the product.
export default function dynamic() {
  return function DynamicFixture() {
    return null;
  };
}
