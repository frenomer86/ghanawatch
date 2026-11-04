-- GhanaWatch keeps to land and water: the air-and-heat forecasts are dropped (they were model forecasts,
-- refetched every three hours, so nothing is lost). The power-cut tracker is no longer on the site; its
-- table "power_reports" is left in place with whatever it holds.
-- Down: recreate "district_air_heat" from 0018_air_heat.sql.

DROP TABLE IF EXISTS "district_air_heat";
