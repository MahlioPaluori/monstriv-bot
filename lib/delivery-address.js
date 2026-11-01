export const COMBINED_DELIVERY_ADDRESS_FORMAT = "combined_v1";

export function normalizeDeliveryAddress(value) {
  return String(value ?? "").trim();
}

export function usesCombinedDeliveryAddress(data) {
  return data?.deliveryAddressFormat === COMBINED_DELIVERY_ADDRESS_FORMAT;
}

export function markCombinedDeliveryAddressWorkflow(data) {
  data.deliveryAddressFormat = COMBINED_DELIVERY_ADDRESS_FORMAT;
  return data;
}

export function inferStoredDeliveryAddressFormat(city, novaPoshtaBranch) {
  const address = normalizeDeliveryAddress(city);
  const branch = normalizeDeliveryAddress(novaPoshtaBranch);
  return !branch && address
    ? COMBINED_DELIVERY_ADDRESS_FORMAT
    : null;
}

export function formatDeliveryAddressForCombinedWorkflow(data) {
  const city = normalizeDeliveryAddress(data?.city);
  const branch = normalizeDeliveryAddress(data?.novaPoshtaBranch);
  if (usesCombinedDeliveryAddress(data)) return city;
  if (!city) return branch;
  if (!branch) return city;
  const normalizedCity = city.toLocaleLowerCase("uk-UA");
  const normalizedBranch = branch.toLocaleLowerCase("uk-UA");
  if (normalizedCity.includes(normalizedBranch)) return city;
  if (normalizedBranch.includes(normalizedCity)) return branch;
  return `${city}, ${branch}`;
}

export function prepareDeliveryAddressDataForReuse(data) {
  const copy = { ...(data || {}) };
  const address = formatDeliveryAddressForCombinedWorkflow(copy);
  if (address) setCombinedDeliveryAddress(copy, address);
  return copy;
}

export function setCombinedDeliveryAddress(data, value) {
  data.city = normalizeDeliveryAddress(value);
  data.novaPoshtaBranch = "";
  data.deliveryAddressFormat = COMBINED_DELIVERY_ADDRESS_FORMAT;
  return data.city;
}
