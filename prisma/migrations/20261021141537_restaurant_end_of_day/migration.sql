-- 1440 is the exclusive end-of-day boundary; starts remain actual minutes.
ALTER TABLE "restaurant_menu_availability_windows"
  DROP CONSTRAINT "restaurant_menu_availability_windows_minutes_range_ck",
  ADD CONSTRAINT "restaurant_menu_availability_windows_minutes_range_ck"
  CHECK ("startMinutes" BETWEEN 0 AND 1439 AND "endMinutes" BETWEEN 0 AND 1440);
