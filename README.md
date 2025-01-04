# EPEX day ahead electricity price in Homebridge

NOTE: WIP

The Homebridge EPEX Day Ahead Energy Price plugin is a project originally forked from [https://github.com/anon1y4012/homebridge-energy-price#readme). 

This version has been modified to get energy prices (electricity) in Europe via the EPEX day ahead spot price (https://www.epexspot.com/en) published via the public ENTSO-E transparency platform (https://transparency.entsoe.eu).

# EPEX Electricity price data access and this plugin

> [!IMPORTANT]
> This Homebridge plugin requires that you obtain your own API access key on ENTSO-E.
>
>Instructions here: (https://transparencyplatform.zendesk.com/hc/en-us/articles/12845911031188-How-to-get-security-token)


---

## Installation

The easiest installation method is to use Homebridge Configuration UI and search for this plugin.

## Configuration

You will need to add the following example accessory configuration to your homebridge `config.json`:

Bidding Zone EIC information: (https://transparencyplatform.zendesk.com/hc/en-us/articles/15885757676308-Area-List-with-Energy-Identification-Code-EIC)

For example for the Netherlands use: `BZN|NL`

```json
"accessories": [
    {
        "name": "EPEX Day Ahead Energy Price",
        "manufacturer": "ENTSO-E EPEX Day-Ahead Price",
        "model": "EPEX Day-Ahead Energy Price Monitor",
        "accessory": "EPEX Day-Ahead Energy Price"
    }
]
```

### Configuration Explanation

Field | Description
----- | -----------
**accessory** | (required) Must always be "Energy Price".
**name** | (required) The name you want to use for the power level widget.
**manufacturer** | (optional) This shows up in the HomeKit accessory characteristics.
**model** | (optional) This shows up in the HomeKit accessory characteristics.
**refreshInterval** | (optional) The refresh interval in minutes for polling ComEd. The default is 5 minutes.
