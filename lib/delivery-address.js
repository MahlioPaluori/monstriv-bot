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

export function setCombinedDeliveryAddress(data, value) {
  data.city = normalizeDeliveryAddress(value);
  data.novaPoshtaBranch = "";
  data.deliveryAddressFormat = COMBINED_DELIVERY_ADDRESS_FORMAT;
  return data.city;
}
