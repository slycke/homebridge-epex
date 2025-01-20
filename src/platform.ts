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

  // all the price data - typically 48h (current + next day), to be used later for triggering alerts
  private allSlots: Array<{ start: Date; price: number }> = [];

  private currentPrice: number | null = null;
  private lastSlotHour: number | null = null;
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

    // Define a fallback slot and price
    const fallbackSlot = () => ({
      start: new Date(),
      // fallback: price to be published in case the API provides no data
      // Can not be higher than 100. Set to 1000 here because all prices are in Euro/MWh but
      // published as ct/kWh.
      // Limitation: https://developers.homebridge.io/#/characteristic/CurrentTemperature
      price: 1000,
    });

    let currentSlot = fallbackSlot(); // default to fallback

    // Check if the API key is present in the config, if not return early with fallback data
    if (!this.config.apiKey || this.config.apiKey.trim() === '') {
      this.log.warn('ENTSO-E API key is missing. Cannot fetch energy price data.');
      const priceCtKwh = currentSlot.price / 10;
      this.setCurrentPrice(priceCtKwh);
      this.updateAccessories();
      return;
    }

    try {
      // Build request window & URL
      const { start, end } = this.getEntsoeWindowFor48h();
      const inOutDomain = this.config.in_Domain || '10YNL----------L';
      const token = this.config.apiKey || 'invalid_token';
      const url = 'https://web-api.tp.entsoe.eu/api'
        + '?documentType=A44'
        + `&in_Domain=${inOutDomain}`
        + `&out_Domain=${inOutDomain}`
        + `&periodStart=${start}`
        + `&periodEnd=${end}`
        + `&securityToken=${token}`;

      // this.log.debug('Sending URL to ENTSO-E:', url);
      const response = await axios.get(url);

      // this.log.debug('Response from ENTSO-E:', response.data);
      const timeslots = await this.parseAllTimeslots(response.data);

      const now = Date.now();

      // If no slots
      if (!timeslots || timeslots.length === 0) {
        this.log.warn('No timeslots returned by the API. Falling back to price=100.');
        currentSlot = fallbackSlot();
      } else {
        // If the current time is before the first slot provided by the ENTSOE API
        if (now < timeslots[0].start.getTime()) {
          this.log.warn('ENTSO-E API did not return complete data!');
          this.log.warn(`All timeslots are in the future (now < ${timeslots[0].start.toISOString()})`);
          this.log.warn('Falling back to price=100.');
          currentSlot = fallbackSlot();
        }
        // Else if the current time is after the last slot's end provided by the ENTSOE API
        else {
          const last = timeslots[timeslots.length - 1];
          const lastSlotEnd = last.start.getTime() + 60 * 60 * 1000; // 1-hour assumption
          if (now >= lastSlotEnd) {
            this.log.warn(`All slots ended by ${last.start.toISOString()}. Falling back to price=100.`);
            currentSlot = fallbackSlot();
          }
          // Otherwise, find the current slot (expected normal flow)
          else {
            const found = timeslots.find((slot, idx) => {
              const next = timeslots[idx + 1];
              // If there is no next slot, this is the last slot -> use it
              if (!next) {
                return true;
              }
              // Otherwise, return true if slot.start <= now < next.start
              return slot.start.getTime() <= now && now < next.start.getTime();
            });

            if (!found) {
              this.log.warn('No suitable slot found. Falling back to max price=100.');
              currentSlot = fallbackSlot();
            } else {
              currentSlot = found;
            }
          }
        }
      }

      const currentSlotHour = currentSlot.start.getHours();
      const priceCtKwh = currentSlot.price / 10; // convert from Euro/MWh to ct/kWh

      // Compare only the hour. If it changes, log info:
      if (this.lastSlotHour !== currentSlotHour) {
        this.lastSlotHour = currentSlotHour;
        // Log the slot details in a friendly way
        const date = new Date(currentSlot.start);
        const formattedDate = date.toLocaleDateString('en-CA', { year: 'numeric', month: 'numeric', day: 'numeric' });
        const formattedTime = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        const endHour = (parseInt(formattedTime.split(':')[0], 10) + 1) % 24;
        const endHourStr = String(endHour).padStart(2, '0') + ':' + formattedTime.split(':')[1];
        this.log.info(`Current time slot (local time) is ${formattedDate} ${formattedTime} - ${endHourStr}, ` +
          `EPEX price (Euro/MWh)=${currentSlot.price}`);
        this.log.info(`Published current EPEX Energy Price (ct/kWh): ${priceCtKwh}`);
      } else {
        // No hour change → optional debug
        this.log.debug(`Still hour ${currentSlotHour}; no new log.`);
      }

      // Always publish the price (even if no update)
      this.setCurrentPrice(priceCtKwh);
      this.updateAccessories();

    } catch (error) {
      this.log.warn('Error fetching or parsing ENTSO-E data:', error);
      // fallback
      currentSlot = fallbackSlot();
      const priceCtKwh = currentSlot.price / 10;
      this.setCurrentPrice(priceCtKwh);
      this.updateAccessories();
    }
  }

  // Helper function that returns a start/end in the "YYYYMMDDHHmm" format for 48 hours
  private getEntsoeWindowFor48h(): { start: string, end: string } {
    // Start at today’s midnight UTC
    const now = new Date();
    const todayMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));

    // The end is "todayMidnight + 48h"
    const tomorrowMidnightPlus48 = new Date(todayMidnight.getTime() + 48 * 60 * 60 * 1000);

    // Debug
    this.log.debug(`[DEBUG] Current UTC time: ${now.toISOString()}`);
    this.log.debug(`[DEBUG] Today’s midnight UTC: ${todayMidnight.toISOString()}`);
    this.log.debug(`[DEBUG] 48 hours from today’s midnight UTC: ${tomorrowMidnightPlus48.toISOString()}`);

    // Convert to the ENTSO-E string
    const startStr = this.toEntsoeDateString(todayMidnight);
    const endStr = this.toEntsoeDateString(tomorrowMidnightPlus48);

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

    // Log a CSV-like matrix for debugging
    // Create "ISO,Price" lines
    let matrixOutput = 'DateTime(UTC),Price (ct/kWh)\n';
    for (const slot of allTimeslots) {
      const isoStr = slot.start.toISOString(); // e.g. "2025-01-07T03:00:00.000Z"
      matrixOutput += `${isoStr},${slot.price/10}\n`;
    }
    this.log.debug('--- ENTSO-E Full-Day Timeslots ---\n' + matrixOutput);

    // Return the full array
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