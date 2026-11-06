/**
 * Deploy script for testing the CLI in separate processes. Configured by
 * environment variables:
 * - E2E_STACK: stack name
 * - E2E_DIR: directory for probes on the VMs
 * - E2E_VALUE: value of the probe
 * - E2E_HOSTS: comma-separated VM names
 */
import { deploy, on } from '../../..';
import { type TestVm, vmHost } from '../helpers';
import { probe } from './types';

const env = (name: string) => {
    const value = process.env[name];
    if (value === undefined) {
        throw new Error(`missing ${name}`);
    }
    return value;
};

on('*', () => {
    probe('probe', {
        name: 'probe',
        dir: env('E2E_DIR'),
        value: env('E2E_VALUE'),
    });
});

await deploy(
    env('E2E_STACK'),
    env('E2E_HOSTS')
        .split(',')
        .map((vm) => vmHost(vm as TestVm)),
);
