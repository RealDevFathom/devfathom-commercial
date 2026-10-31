#!/bin/sh

set -eu

source_dir=${1:-./src}
destination_dir=${2:-/runtime-src}

rm -rf "$destination_dir"
mkdir -p "$destination_dir"
cp -R "$source_dir"/. "$destination_dir"/

# Tests are colocated with production modules, so prepare a clean source tree
# rather than copying src directly into the runtime image.
find "$destination_dir" -type f \( \
  -name '*.test.*' -o -name '*.spec.*' -o -name '*.fixture.*' -o -name '*.mock.*' \
\) -delete
find "$destination_dir" -type d \( \
  -name '__tests__' -o -name '__snapshots__' -o -name 'testing' -o \
  -name 'test-support' -o -name 'fixtures' -o -name 'mocks' \
\) -prune -exec rm -rf {} +
rm -f "$destination_dir/app/api/trpc/transaction-boundary.real-http.runner.py"
