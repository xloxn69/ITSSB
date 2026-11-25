# 02 — Hardware assembly and the physical bus device

**I.T.S.S.B. — Intelligence Transportation System for School Buses**

This guide explains what your purchased hardware does, how the pieces connect, and what remains necessary before a vehicle installation. It describes the planned system; it does not claim that GPS reception or bus operation has been tested on your unit.

Read next: [Raspberry Pi setup](03_RASPBERRY_PI_SETUP.md), [Pi software](04_RASPBERRY_PI_SOFTWARE.md), and [troubleshooting](16_TROUBLESHOOTING.md).

## 1. What you already bought

| Component | Your listed price | Its job |
| --- | ---: | --- |
| Raspberry Pi 5, 2GB | $77.50 | Runs Linux, the local application, GPS processing, and synchronization. |
| Raspberry Pi Touch Display 2, seven-inch | $81.95 | Provides driver touch input and visual output. |
| SmartiPi Touch Pro 3, Large | $44.99 | Houses the display and Pi in one assembly. |
| SmartiPi Pi 5 fan | $7.99 | Removes heat from the enclosure. |
| Official 27W USB-C power supply | $12.95 | Powers the desk development setup. |
| 64GB microSD with Raspberry Pi OS | $20.95 | Stores the OS, application, configuration, and local records. |
| GlobalSat BU-353N5 USB GPS | $49.95 | Supplies satellite positioning observations. |
| **Total from your figures** | **$296.28** | Before tax and shipping. |

These are your purchase figures, not current retail quotations. The screen, fan, and GPS work together through the Pi; none is independently an I.T.S.S.B. application.

The Pi is a small computer. The microSD behaves like its main disk, the display behaves like a touch monitor, and the GPS behaves like an external data source. Python software that you build will connect those capabilities to the school transportation workflow.

## 2. What goes into the enclosure

The intended assembly contains the display, Pi, fan, the applicable mounting hardware, and routed internal display cables. The GPS puck stays outside the enclosure where its reception and cable routing can be appropriate. The USB-C power cable connects to the Pi from outside.

Keep ventilation openings clear. Ensure cables do not contact the fan blades, pinch under covers, or pull sideways on small connectors. The Large case provides space, but available space does not make an unsupported modification electrically or mechanically correct.

Smarticase identifies this case as compatible with the Pi 5 and seven-inch Touch Display 2. Its mounting arrangement and microSD access should be checked against the included case instructions. [Manufacturer case information](https://smarticase.com/products/smartipi-touch-pro-3)

If your assembled display already boots successfully, preserve that working state. You do not need to dismantle it merely to follow this document. Inspect only the connection that is relevant when diagnosing a problem.

## 3. Display data and display power are different connections

The display uses a ribbon connection for its display/touch interface and a separate power lead. Raspberry Pi specifies a **22-way-to-15-way ribbon for Pi 5**. The smaller end goes to the Pi camera/display connector and the larger end goes to the display. The display power lead connects **red to physical header pin 2 (5V)** and **black to physical header pin 6 (ground)**.

Those are physical connector positions, not BCM GPIO signal numbers. Disconnect power before changing either connection. Follow the official orientation photographs rather than guessing which way the exposed ribbon contacts face. [Official Touch Display 2 instructions](https://www.raspberrypi.com/documentation/accessories/touch-display-2.html)

The proposed driver interface is landscape. The display's native arrangement is 720 × 1280; rotating the desktop gives the intended **1280 × 720** layout. Test the displayed orientation and touch coordinates together: touch each corner and several buttons after rotation.

Use the desktop's display settings for the initial configuration. Avoid collecting unrelated legacy display configuration lines from older tutorials. A setting intended for an older display stack may not apply to your installed desktop.

## 4. Fan connection and cooling

The matching SmartiPi Pi 5 fan attaches to the case's fan mount and uses the dedicated Pi 5 fan connector. Follow the manufacturer's fan guide; do not substitute the display's power pins for the intended fan connection. [Manufacturer fan information](https://smarticase.com/products/smartipi-touch-pro-3-fan-for-raspberry-pi-5)

Cooling is temperature controlled. A fan that is stopped while the Pi is cool is not automatically defective. Check temperature and sustained operation rather than expecting constant rotation.

For the prototype, record temperature and any throttling indicators while Chromium, GPS collection, and uploads run together. The 2GB model benefits from a lightweight UI, a single browser window, and bounded background work. Rendering a map does not justify running a large model or a large development environment continuously on the bus.

## 5. GPS USB connection and placement

Connect the BU-353N5 to a Pi USB port. Keep the puck and cable in a position that does not interfere with controls, visibility, or movement.

On Linux, USB detection and a satellite fix are separate milestones:

1. The USB system sees the receiver.
2. A serial device is available.
3. GPSD can read the receiver's output.
4. Position reports contain a usable fix.
5. I.T.S.S.B. accepts and saves an observation.

A receiver can pass steps 1–3 while still waiting for satellites. Initial testing should be outdoors with a clear sky view. Do not interpret poor reception indoors as proof that the application is broken.

The reviewed GlobalSat manual specifies default serial framing of **4800 baud, 8 data bits, no parity, one stop bit** for this receiver family. The setup guide normally lets GPSD handle receiver communication; manual serial settings are a diagnostic fallback after confirming the actual device. [GlobalSat manual V1.1](https://www.globalsat.com.tw/files/User%20Manual-BU-353N5_BR-355N5%20V1.1_20240905.pdf)

Do not assume that it will always be named `/dev/ttyUSB0`. Linux numbering can change when devices are added or reconnected. The setup guide explains how to inspect the actual device and use a stable identity where available.

The GPS receiver provides position information. It does not supply a cellular connection, the student's location, a count of passengers, or proof that a door opened.

## 6. Power for the desk prototype

Use the official supply for development. Raspberry Pi documents a **5.1V/5A** output profile for its official 27W supply. A different charger's total advertised wattage does not establish that it provides the same required output profile. [Official power-supply information](https://www.raspberrypi.com/products/27w-power-supply/)

The Pi powers connected peripherals, so test the complete assembly rather than the bare board alone. A setup that works without the display and GPS may behave differently when both are attached.

Use the OS shutdown command before removing power when practical:

~~~bash
sudo poweroff
~~~

Wait until shutdown has completed before disconnecting power. This is an operating-system command, not a substitute for vehicle power-loss protection. The seven purchased components contain no backup battery that can keep the Pi running after power disappears.

## 7. What a vehicle installation adds

The enclosure is a prototype assembly, not a finished vehicle installation. Before a school-bus pilot, the responsible organization needs to choose and validate:

- A secure mount appropriate for the vehicle and installation location.
- A regulated power source appropriate to that vehicle's electrical system.
- Protection, fusing, strain relief, and cable routing.
- An orderly shutdown or suitable power-loss strategy.
- Independent mobile internet and a data service.
- Approved driver interaction and maintenance procedures.

Have the responsible vehicle professional choose and install the electrical and mounting arrangement. Do not connect vehicle supply voltage directly to the Pi. The case's desk stand and mounting holes do not themselves demonstrate a crash-safe installation.

A hotspot can support an authorized supervised development test. For an eventual operational unit, a dedicated router avoids making bus connectivity depend on a particular person's phone being present. The final router and power parts are decisions still to make, not items already included in your purchase list.

## 8. First hardware acceptance checklist

Use this checklist at a desk before adding custom application complexity.

- [ ] The existing microSD installation boots without unnecessary reimaging.
- [ ] The screen has a stable image.
- [ ] Landscape rotation and touch alignment agree.
- [ ] The Pi and cables are secured without blocking ventilation.
- [ ] The fan connection matches the case manufacturer's guide.
- [ ] The complete assembly runs from the official supply.
- [ ] Linux detects the GPS USB device.
- [ ] GPSD reports usable coordinates outdoors.
- [ ] A normal shutdown and restart succeed.
- [ ] There is a recorded OS version and hardware inventory for troubleshooting.

Passing these checks establishes a hardware baseline. It does not establish a working cloud backend, an installed I.T.S.S.B. application, accurate arrival predictions, or approval for vehicle use.

## 9. What not to display as measured hardware data

The current purchases do not include door, seat, seatbelt, ignition, or passenger-occupancy sensors. A seat number is an assignment entered by staff. A check-in count is a count of records. A Parked badge is a driver-confirmed operating state with a software motion guard.

Do not add a fabricated battery gauge. If power management hardware is added later, expose only measurements that the actual integration provides and test how they behave.

## Sources

- [Raspberry Pi Touch Display 2 documentation](https://www.raspberrypi.com/documentation/accessories/touch-display-2.html)
- [SmartiPi Touch Pro 3](https://smarticase.com/products/smartipi-touch-pro-3)
- [SmartiPi Touch Pro 3 fan for Pi 5](https://smarticase.com/products/smartipi-touch-pro-3-fan-for-raspberry-pi-5)
- [Official Raspberry Pi 27W supply](https://www.raspberrypi.com/products/27w-power-supply/)
- [GlobalSat BU-353N5 product](https://www.globalsat.com.tw/en/product-289508/USB-GNSS-Receiver-BU-353N5.html)
- [GlobalSat receiver manual V1.1](https://www.globalsat.com.tw/files/User%20Manual-BU-353N5_BR-355N5%20V1.1_20240905.pdf)

Platform details were checked for this documentation on 2026-11-25. Confirm the instructions supplied with your actual hardware revision before changing connections.

