export const isValidProjectDateRange = (
  startDate: Date | string | null | undefined,
  endDate: Date | string | null | undefined
) => {
  if (!startDate || !endDate) return true;
  const startTime = startDate instanceof Date ? startDate.getTime() : new Date(startDate).getTime();
  const endTime = endDate instanceof Date ? endDate.getTime() : new Date(endDate).getTime();
  return endTime >= startTime;
};
