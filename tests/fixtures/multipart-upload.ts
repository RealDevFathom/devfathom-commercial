/** One local multipart request with an inert file of the stated size. */
export function multipartUpload(path: string, sizeMiB: number) {
  const origin = 'https://tenant.example.test';
  const form = new FormData();
  form.set(
    'file',
    new File([new Uint8Array(sizeMiB * 1024 * 1024)], 'proof.jpg', { type: 'image/jpeg' })
  );
  for (const [key, value] of Object.entries({
    branchId: 'branch-1',
    pharmacyBranchId: 'pbranch_1',
    occurrenceId: 'occ_1',
    occurrenceStepId: 'ostep_1',
    evidencePurpose: 'photo',
  }))
    form.set(key, value);
  return new Request(origin + path, {
    method: 'POST',
    headers: { origin, host: 'tenant.example.test' },
    body: form,
  });
}
