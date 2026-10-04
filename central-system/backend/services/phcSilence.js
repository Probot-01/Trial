'use strict';



const PHC_SILENT_HOURS = (() => {
  const v = Number(process.env.PHC_SILENT_HOURS);
  return Number.isFinite(v) && v > 0 ? v : 24;
})();

/** @param {Date|null} lastContactAt  phc_sites.last_contact_at */
function isSilent(lastContactAt, now = Date.now()) {
  return !lastContactAt || lastContactAt.getTime() < now - PHC_SILENT_HOURS * 3_600_000;
}

module.exports = { PHC_SILENT_HOURS, isSilent };
