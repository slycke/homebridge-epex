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

  // all the price data - typicaly 48h (current + next day)
  private allSlots: Array<{ start: Date; price: number }> = [];

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
      // use the new function:
      const { start, end } = this.getEntsoeWindowFor48h();
      const startDate = start;   // "YYYYMMDD0000"
      const endDate = end;     // "YYYYMMDD0000" + 2 days if you want 48 hours

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

      const timeslots = await this.parseAllTimeslots(response.data);

      this.allSlots = timeslots;

      const now = Date.now();
      let currentSlot = this.allSlots.length > 0 ? this.allSlots[0] : null;

      for (let i = 0; i < this.allSlots.length; i++) {
        const slot = this.allSlots[i];
        const nextSlot = this.allSlots[i + 1];
        if (!nextSlot) {
          // If there's no next slot, we must be in the last slot
          currentSlot = slot;
          break;
        }
        // If slot.start <= now < nextSlot.start, we found our slot
        if (slot.start.getTime() <= now && nextSlot.start.getTime() > now) {
          currentSlot = slot;
          break;
        }
      }

      if (!currentSlot) {
        // fallback if something weird happened
        currentSlot = { start: new Date(), price: this.config.max_rate || 100 };
      }

      // Log debug info
      this.log.info(`Current time slot is ${currentSlot.start.toISOString()}, EPEX price=${currentSlot.price}`);
      // in Euro ct/kWh
      this.setCurrentPrice(currentSlot.price/10);

      this.log.info(`Published current EPEX Energy Price: ${this.getCurrentPrice()}`);
      this.updateAccessories();
    } catch (error) {
      this.log.error('Error fetching or parsing ENTSO-E data:', error);
    }
  }

  // Helper function that returns a start/end in the "YYYYMMDDHHmm" format for 48 hours
  private getEntsoeWindowFor48h(): { start: string, end: string } {
    // 1) Start at today’s midnight UTC
    const now = new Date();
    const todayMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));

    // 2) The end is "todayMidnight + 48h"
    const tomorrowMidnightPlus24 = new Date(todayMidnight.getTime() + 48 * 60 * 60 * 1000);

    // 3) Convert to the ENTSO-E string
    const startStr = this.toEntsoeDateString(todayMidnight);
    const endStr = this.toEntsoeDateString(tomorrowMidnightPlus24);

    return { start: startStr, end: endStr };
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
 * Parse the ENTSO-E XML response for a full set of day-ahead timeslots.
 * Returns an array of { start: Date, price: number } for each timeslot.
 */
  private async parseAllTimeslots(xmlData: string): Promise<Array<{ start: Date; price: number }>> {
    // 1) Parse XML
    const result = await parseStringPromise(xmlData, { explicitArray: false });
    const timeSeries = result?.Publication_MarketDocument?.TimeSeries;

    // If no TimeSeries, return empty
    if (!timeSeries) {
      this.log.warn('No TimeSeries found in ENTSO-E response');
      return [];
    }

    // In some cases, `TimeSeries` can be an array of multiple series
    const seriesArray = Array.isArray(timeSeries) ? timeSeries : [timeSeries];

    // We'll accumulate all timeslots here
    const allTimeslots: { start: Date; price: number }[] = [];

    for (const series of seriesArray) {
      // Each series can have multiple Periods
      const periodArray = Array.isArray(series.Period) ? series.Period : [series.Period];

      for (const per of periodArray) {
        // The official start time of this Period
        const periodStartStr = per.timeInterval?.start;
        if (!periodStartStr) {
          this.log.warn('Period missing timeInterval.start');
          continue;
        }

        // Determine resolution (often "PT60M" for hourly, "PT15M" for quarter-hour)
        const resolution = per.resolution || 'PT60M';
        const minutesPerSlot = resolution === 'PT15M' ? 15 : 60; // Basic assumption

        // Convert periodStartStr to a Date
        const dtStart = new Date(periodStartStr);

        // Points can be array or single
        const points = Array.isArray(per.Point) ? per.Point : [per.Point];

        for (const p of points) {
          const rawPos = parseInt(p.position || '1', 10) - 1;
          const rawPrice = parseFloat(p['price.amount'] || '0');
          const price = isNaN(rawPrice) ? 0 : rawPrice;

          // Compute timeslot start by adding (rawPos * minutesPerSlot) to dtStart
          const slotStart = new Date(dtStart.getTime() + rawPos * minutesPerSlot * 60000);

          allTimeslots.push({
            start: slotStart,
            price: price,
          });
        }
      }
    }

    // Sort all timeslots by start time
    allTimeslots.sort((a, b) => a.start.getTime() - b.start.getTime());

    // 2) Log a CSV-like matrix for debugging
    //    We'll create "ISO,Price" lines
    let matrixOutput = 'DateTime(UTC),Price\n';
    for (const slot of allTimeslots) {
      const isoStr = slot.start.toISOString(); // e.g. "2025-01-07T03:00:00.000Z"
      matrixOutput += `${isoStr},${slot.price}\n`;
    }

    this.log.info('--- ENTSO-E Full-Day Timeslots ---\n' + matrixOutput);

    // 3) Return the full array
    return allTimeslots;
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