#!/bin/sh
set -eu

source_dir=${1:?source directory is required}
runtime_dir=${2:?runtime directory is required}

test -d "$source_dir"
test ! -e "$runtime_dir"

cp -a -- "$source_dir" "$runtime_dir"
find "$runtime_dir" -type f -name '*.test.*' -delete
rm -rf -- "$runtime_dir/lib/testing"
