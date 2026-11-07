import { GENERATED } from './completion.ts';

/**
 * Starter automations and a short guide to the DSL, shown in the editor's Guide panel.
 * Automations are TypeScript: the editor says so, and the examples are compiled in tests so
 * they can't drift from the DSL.
 */

export interface Example {
  id: string;
  title: string;
  blurb: string;
  /** Device names used, so the panel can say which ones to swap for your own. */
  source: string;
}

const IMPORT = `from '${GENERATED}'`;

export const EXAMPLES: Example[] = [
  {
    id: 'door-light',
    title: 'Light when a door opens',
    blurb: 'A trigger and a few actions, with a pause in between.',
    source: `import { automation, sleep } from '@sebastian/dsl';
import { frontDoor, hallLight } ${IMPORT};

// frontDoor and hallLight are device names from your location: replace them with your own.
export default automation('Hall light')
  .when(frontDoor.contactSensor.contact.changesTo('open'))
  .do(hallLight.switch.on(), sleep(30), hallLight.switch.off());
`,
  },
  {
    id: 'night-only',
    title: 'Only at night',
    blurb: 'Conditions with onlyIf: modes and time windows.',
    source: `import { at, automation, between, sunset } from '@sebastian/dsl';
import { frontDoor, hallLight, Home } ${IMPORT};

// .onlyIf is checked when the trigger fires. The conditions are all required.
export default automation('Hall light at night')
  .when(frontDoor.contactSensor.contact.changesTo('open'))
  .onlyIf(Home.mode.is('Night'), between(sunset(), at('23:00')))
  .do(hallLight.switch.on());
`,
  },
  {
    id: 'schedule',
    title: 'Every morning',
    blurb: 'A schedule trigger instead of a device trigger.',
    source: `import { at, automation, every } from '@sebastian/dsl';
import { hallLight } ${IMPORT};

export default automation('Hall light off in the morning')
  .when(every.on(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], at('07:30')))
  .do(hallLight.switch.off());
`,
  },
  {
    id: 'branch',
    title: 'Either/or',
    blurb: 'Different actions depending on a condition, with otherwise.',
    source: `import { automation } from '@sebastian/dsl';
import { frontDoor, hallLight, Home } ${IMPORT};

export default automation('Welcome')
  .when(frontDoor.contactSensor.contact.changesTo('open'))
  .onlyIf(Home.mode.is('Night'))
  .do(hallLight.switch.on())
  .otherwise(hallLight.switch.off());
`,
  },
];

export const GUIDE: { title: string; body: string; code?: string }[] = [
  {
    title: 'It’s TypeScript',
    body: 'Each file is a TypeScript module that default-exports one automation. It is compiled in your browser (never on the server), and the result is checked as you type. Save, then Plan and Apply to deploy.',
  },
  {
    title: 'Shape of an automation',
    body: 'Name it, say what starts it, optionally what must be true, then what it does.',
    code: `export default automation('Name')
  .when(trigger)         // what starts it
  .onlyIf(condition)     // optional, checked when it starts
  .do(action, action)    // what it does
  .otherwise(action);    // optional, when onlyIf fails`,
  },
  {
    title: 'Devices',
    body: 'Start typing a device name and pick it: it is imported for you. Then use dots: device, capability, attribute or command. Ctrl+Space shows what is available at each step.',
    code: `hallLight.switch.on()                       // command: an action
hallLight.switchLevel.setLevel(60)          // command with a value
door.contactSensor.contact.changesTo('open') // attribute: a trigger
temp.temperatureMeasurement.temperature.isAbove(70) // attribute: a condition`,
  },
  {
    title: 'Triggers vs conditions',
    body: 'changesTo, risesAbove and fallsBelow are triggers (use in .when). is, isNot, isAbove and isBelow are conditions (use in .onlyIf). Combine conditions with all(), any() and not().',
  },
  {
    title: 'Time, modes and waiting',
    body: "at('HH:MM'), sunrise(), sunset() and noon() take an optional offset in minutes. between(a, b) is a time window. every.day(…) and every.on([…], …) are schedules. Home.mode.is('Night') checks the location mode. sleep(seconds) waits.",
  },
  {
    title: 'Safety',
    body: "Commands that unlock, open or disarm must be allowed explicitly with .allowDangerous('reason'). Automations that can’t run on the hub show as Cloud in the editor.",
  },
];
