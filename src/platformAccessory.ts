import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { EPEXMonitor } from './platform.js';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class EPEXPlatformAccessory {
  private service: Service;

  constructor(
    private readonly platform: EPEXMonitor,
    private readonly accessory: PlatformAccessory,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'ENTSO-E')
      .setCharacteristic(this.platform.Characteristic.Model, 'Energy Price Monitor')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, '123-456-789');

    // Create or retrieve the TemperatureSensor service
    this.service = this.accessory.getService(this.platform.Service.TemperatureSensor)
      || this.accessory.addService(this.platform.Service.TemperatureSensor);

    // Set the service name
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      accessory.context.device.name || 'Default Name', // Add a fallback here
    );

    // Initialize with the current price
    const currentPrice = this.platform.getCurrentPrice();
    this.updatePrice(currentPrice);

    // Register GET characteristic handler for CurrentTemperature
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));
  }

  /**
   * Update the accessory with the latest price.
   * If the price is null, it logs a warning and does not update the characteristic.
   */
  public updatePrice(price: number | null): void {
    if (price !== null) {
      this.platform.log.debug(`Updating price for ${this.accessory.displayName}: ${price}`);
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        price as CharacteristicValue,
      );
    } else {
      this.platform.log.warn(`Price unavailable for ${this.accessory.displayName}.`);
    }
  }

  /**
   * Handle GET requests for the CurrentTemperature characteristic.
   * Throws an error if the price is unavailable.
   */
  private handleCurrentTemperatureGet(): CharacteristicValue {
    const currentPrice = this.platform.getCurrentPrice();

    if (currentPrice === null) {
      this.platform.log.warn(`Current price is unavailable for ${this.accessory.displayName}`);
      //throw new this.platform.api.hap.HapStatusError(
      //  this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      //);
    }

    this.platform.log.debug(`[DEBUG] Current price for ${this.accessory.displayName}: ${currentPrice}`);
    return currentPrice as CharacteristicValue;
  }
}