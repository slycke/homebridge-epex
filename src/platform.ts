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
      this.setCurrentPrice(this.config.max_price || 100); // Set to a fallback value
      this.updateAccessories();
      return;
    }
    try {
      const now = new Date();
      now.setUTCMinutes(0, 0, 0);

      const startDate = this.toEntsoeDateString(now);
      const endDate = this.toEntsoeDateString(new Date(now.getTime() + 60 * 60 * 1000));
      const token = this.config.apiKey || 'invalid_token';

      const url = 'https://web-api.tp.entsoe.eu/api' +
        `?documentType=${this.config.documentType || 'A44'}` +
        `&in_Domain=${this.config.in_Domain || '10YNL----------L'}` +
        `&out_Domain=${this.config.out_Domain || '10YNL----------L'}` +
        `&periodStart=${startDate}` +
        `&periodEnd=${endDate}` +
        `&securityToken=${token}`;

      this.log.info('Sending URL to ENTSO-E: ' + url);

      const response = await axios.get(url);

      // this.log.info('Response from ENTSO-E: ' + response.data);

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
      // In some responses, `TimeSeries` could be an array. Here we just pick the first (or adapt as needed).
      const series = Array.isArray(timeSeries) ? timeSeries[0] : timeSeries;
  
      // Likewise, Period can be an array or single object
      const period = Array.isArray(series.Period) ? series.Period[0] : series.Period;
      const points = Array.isArray(period.Point) ? period.Point : [period.Point];
  
      // Build an array of { time, price } to log
      const timePriceArray: { time: string, price: number }[] = [];
  
      for (const p of points) {
        // Example: p might have:
        // {
        //   position: "1",
        //   'price.amount': "123.45"
        // }
  
        // 1. Convert price to a float
        const rawPrice = parseFloat(p['price.amount'] || '0');
        const price = isNaN(rawPrice) ? 0 : rawPrice;
  
        // 2. Build a time label from the 'position' or something else
        //    Many ENTSO-E responses simply have position #, not the exact start time
        //    If you need the exact start time, you can compute from period.timeInterval + position
        //    For simplicity, we just log 'position' here as the time placeholder.
        const position = p.position || 'Unknown';
  
        timePriceArray.push({
          time: position,
          price: price,
        });
      }
  
      // Log in a matrix format suitable for copy/paste
      // e.g., two columns: "Time,Price"
      let matrixOutput = 'Time,Price\n';
      for (const entry of timePriceArray) {
        matrixOutput += `${entry.time},${entry.price}\n`;
      }
  
      // Log the matrix
      this.log.info('--- ENTSO-E Data (Time vs. Price) ---\n' + matrixOutput);
  
      // Return the *first* price as the main return value, same as before
      // (Adjust if you need a different logic, e.g., average)
      return timePriceArray.length > 0 ? timePriceArray[0].price : 0;
    }
  
    // Fallback if no TimeSeries
    return 0;
  }

  /**
   * Convert a date to the ENTSO-E required format (YYYYMMDDHHmm).
   */
  private toEntsoeDateString(date: Date): string {
    // "2025-01-06T17:00:23.456Z" -> "20250106T1700"
    const iso = date.toISOString();                // "2025-01-06T17:00:23.456Z"
    const cleaned = iso.replace(/[-:]/g, '');      // "20250106T170023.456Z"
    // Keep only "YYYYMMDDTHHMM" => slice(0,13) => "20250106T1700"
    let partial = cleaned.slice(0, 13);            // "20250106T1700"
    partial = partial.replace('T', '');            // "202501061700"
    return partial;                                // "202501061700"
  }

  /**
   * Notify accessories of the updated price.
   */

  private readonly accessoryHandlers = new Map<string, EPEXPlatformAccessory>();

  private updateAccessories() {
    for (const accessory of this.accessories.values()) {
      // Create or retrieve the EPEXPlatformAccessory instance
      let epexAccessory = this.accessoryHandlers.get(accessory.UUID);
      if (!epexAccessory) {
        epexAccessory = new EPEXPlatformAccessory(this, accessory);
        this.accessoryHandlers.set(accessory.UUID, epexAccessory);
      }

      // Update the price
      epexAccessory.updatePrice(this.getCurrentPrice());
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