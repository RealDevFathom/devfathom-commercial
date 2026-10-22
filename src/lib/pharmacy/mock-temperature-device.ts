import { temperatureSensorSignature, type TemperatureSensorPayload } from './temperature-sensor';

/** Deterministic vendor-neutral adapter for demos and contract tests; it performs no I/O. */
export class MockTemperatureDeviceAdapter {
  constructor(
    readonly keyId: string,
    private readonly signingSecret: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  request(payload: TemperatureSensorPayload, url = 'http://pharmacy.localhost/api/pharmacy/temperature/webhook') {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(this.now().getTime() / 1000));
    return new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-device-key-id': this.keyId,
        'x-device-timestamp': timestamp,
        'x-device-signature': temperatureSensorSignature(this.signingSecret, timestamp, body),
      },
      body,
    });
  }
}
