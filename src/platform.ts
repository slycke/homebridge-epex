import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { EPEXPlatformAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

import axios from 'axios';
import { parseStringPromise } from 'xml2js';
/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class EPEXMonitor implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  private currentPrice: number | null = null;
  private timer?: NodeJS.Timeout;

  // Add a getter and setter for currentPrice
  public getCurrentPrice(): number | null {
    return this.currentPrice;
  }
  private setCurrentPrice(price: number): void {
    this.currentPrice = price;
  }

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing EPEX platform:', this.config.name);
    this.log.info('EPEXMonitor initialized.');

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.log.info('Starting EPEXMonitor...');
      this.startPolling();
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }
  /**
* Poll the ENTSO-E API periodically for energy price data.
*/
  private startPolling() {
    const interval = (this.config.refreshInterval || 15) * 60 * 1000;
    this.pollEPEXPrice(); // Initial fetch

    this.timer = setInterval(() => {
      this.pollEPEXPrice();
    }, interval);

    this.log.info(`Polling initialized. Interval: ${interval / 60000} minutes.`);
  }

  /**
 * Fetch price data from the ENTSO-E API.
 */
  private async pollEPEXPrice() {
    // Check if the API key is present in the config
    if (!this.config.apiKey || this.config.apiKey.trim() === '') {
      this.log.warn('ENTSO-E API key is missing. Cannot fetch energy price data.');
      this.setCurrentPrice(this.config.max_rate || 100); // Set to a fallback value
      this.updateAccessories();
      return;
    }
    try {
      const now = new Date();
      now.setUTCMinutes(0, 0, 0);

      const startDate = this.toEntsoeDateString(now);
      const endDate = this.toEntsoeDateString(new Date(now.getTime() + 60 * 60 * 1000));

      const url = 'https://web-api.tp.entsoe.eu/api' +
        `?documentType=${this.config.documentType || 'A44'}` +
        `&in_Domain=${this.config.in_Domain || '10YNL----------L'}` +
        `&out_Domain=${this.config.out_Domain || '10YNL----------L'}` +
        `&periodStart=${startDate}` +
        `&periodEnd=${endDate}`;

      this.log.debug('Fetching data from ENTSO-E:', url);

      const response = await axios.get(url, {
        headers: { 'X-Api-Key': this.config.apiKey || '' },
      });

      const price = await this.parseEPEXResponse(response.data);
      this.setCurrentPrice(price);

      this.log.info(`Fetched price: ${price}`);
      this.updateAccessories();
    } catch (error) {
      this.log.error('Error fetching or parsing ENTSO-E data:', error);
    }
  }

  /**
* Parse the ENTSO-E API response to extract the price.
*/
  private async parseEPEXResponse(data: string): Promise<number> {
    const result = await parseStringPromise(data, { explicitArray: false });
    const timeSeries = result?.Publication_MarketDocument?.TimeSeries;

    if (timeSeries) {
      const period = Array.isArray(timeSeries.Period) ? timeSeries.Period[0] : timeSeries.Period;
      const points = Array.isArray(period.Point) ? period.Point : [period.Point];

      const price = parseFloat(points[0]?.['price.amount'] || '0');
      return isNaN(price) ? 0 : price;
    }

    return 0;
  }

  /**
   * Convert a date to the ENTSO-E required format (YYYYMMDDHHmm).
   */
  private toEntsoeDateString(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').slice(0, 12) + '00';
  }

  /**
   * Notify accessories of the updated price.
   */
  private updateAccessories() {
    for (const accessory of this.accessories.values()) {
      // Create or retrieve the EPEXPlatformAccessory instance
      const epexAccessory = accessory.context.epexHandler || new EPEXPlatformAccessory(this, accessory);

      // Store the handler in the accessory context to avoid recreating it
      accessory.context.epexHandler = epexAccessory;

      // Update the price using the currentPrice property
      if (this.currentPrice !== null) {
        epexAccessory.updatePrice(this.currentPrice);
      } else {
        this.log.warn(`No current price available to update accessory: ${accessory.displayName}`);
      }
    }
  }


  /**
   * Restore cached accessories.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Discover and register accessories.
   */
  private discoverDevices() {
    const exampleDevices = [
      { id: 'PriceMonitor1', name: 'EPEX Price Monitor' },
    ];

    for (const device of exampleDevices) {
      const uuid = this.api.hap.uuid.generate(device.id);

      const existingAccessory = this.accessories.get(uuid);
      if (existingAccessory) {
        this.log.info('Restoring accessory:', existingAccessory.displayName);
        new EPEXPlatformAccessory(this, existingAccessory);
      } else {
        this.log.info('Adding new accessory:', device.name);

        const accessory = new this.api.platformAccessory(
          device.name || 'Unnamed Accessory', // Add a fallback name here
          uuid,
        );
        accessory.context.device = device;

        new EPEXPlatformAccessory(this, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}