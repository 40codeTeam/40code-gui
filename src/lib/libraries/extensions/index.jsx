import React from 'react';
import {FormattedMessage} from 'react-intl';

import musicIconURL from './music/music.png';
import musicInsetIconURL from './music/music-small.svg';

import penIconURL from './pen/pen.png';
import penInsetIconURL from './pen/pen-small.svg';

import videoSensingIconURL from './videoSensing/video-sensing.png';
import videoSensingInsetIconURL from './videoSensing/video-sensing-small.svg';

import text2speechIconURL from './text2speech/text2speech.png';
import text2speechInsetIconURL from './text2speech/text2speech-small.svg';

import translateIconURL from './translate/translate.png';
import translateInsetIconURL from './translate/translate-small.png';

import makeymakeyIconURL from './makeymakey/makeymakey.png';
import makeymakeyInsetIconURL from './makeymakey/makeymakey-small.svg';

import microbitIconURL from './microbit/microbit.png';
import microbitInsetIconURL from './microbit/microbit-small.svg';
import microbitConnectionIconURL from './microbit/microbit-illustration.svg';
import microbitConnectionSmallIconURL from './microbit/microbit-small.svg';

import ev3IconURL from './ev3/ev3.png';
import ev3InsetIconURL from './ev3/ev3-small.svg';
import ev3ConnectionIconURL from './ev3/ev3-hub-illustration.svg';
import ev3ConnectionSmallIconURL from './ev3/ev3-small.svg';

import wedo2IconURL from './wedo2/wedo.png'; // TODO: Rename file names to match variable/prop names?
import wedo2InsetIconURL from './wedo2/wedo-small.svg';
import wedo2ConnectionIconURL from './wedo2/wedo-illustration.svg';
import wedo2ConnectionSmallIconURL from './wedo2/wedo-small.svg';
import wedo2ConnectionTipIconURL from './wedo2/wedo-button-illustration.svg';

import boostIconURL from './boost/boost.png';
import boostInsetIconURL from './boost/boost-small.svg';
import boostConnectionIconURL from './boost/boost-illustration.svg';
import boostConnectionSmallIconURL from './boost/boost-small.svg';
import boostConnectionTipIconURL from './boost/boost-button-illustration.svg';

import gdxforIconURL from './gdxfor/gdxfor.png';
import gdxforInsetIconURL from './gdxfor/gdxfor-small.svg';
import gdxforConnectionIconURL from './gdxfor/gdxfor-illustration.svg';
import gdxforConnectionSmallIconURL from './gdxfor/gdxfor-small.svg';

import twIcon from './tw/tw.svg';
import customExtensionIcon from './custom/custom.svg';
import returnIcon from './custom/return.svg';
import galleryIcon from './gallery/gallery.svg';
// import {APP_NAME} from '../../brand';

import _3dIconURL from './40code/3d.svg';
import lazymusicIconURL from './40code/lazymusic.svg';
import cloudIconURL from './40code/cloud.svg';
import canvasIconURL from './40code/canvas.svg';
import ysSmallIconURL from './40code/ys.svg';
import jsIconURL from './40code/jsonfetch.svg';
import _40code from './40code/40code.svg';

export default [
    {
        name: (
            <FormattedMessage
                defaultMessage="Music"
                description="Name for the 'Music' extension"
                id="gui.extension.music.name"
            />
        ),
        extensionId: 'music',
        iconURL: musicIconURL,
        insetIconURL: musicInsetIconURL,
        description: (
            <FormattedMessage
                defaultMessage="Play instruments and drums."
                description="Description for the 'Music' extension"
                id="gui.extension.music.description"
            />
        ),
        tags: ['scratch'],
        featured: true
    },
    {
        name: (
            <FormattedMessage
                defaultMessage="Pen"
                description="Name for the 'Pen' extension"
                id="gui.extension.pen.name"
            />
        ),
        extensionId: 'pen',
        iconURL: penIconURL,
        insetIconURL: penInsetIconURL,
        description: (
            <FormattedMessage
                defaultMessage="Draw with your sprites."
                description="Description for the 'Pen' extension"
                id="gui.extension.pen.description"
            />
        ),
        tags: ['scratch'],
        featured: true
    },
    {
        name: (
            <FormattedMessage
                defaultMessage="Video Sensing"
                description="Name for the 'Video Sensing' extension"
                id="gui.extension.videosensing.name"
            />
        ),
        extensionId: 'videoSensing',
        iconURL: videoSensingIconURL,
        insetIconURL: videoSensingInsetIconURL,
        description: (
            <FormattedMessage
                defaultMessage="Sense motion with the camera."
                description="Description for the 'Video Sensing' extension"
                id="gui.extension.videosensing.description"
            />
        ),
        tags: ['scratch'],
        featured: true
    },
    {
        name: (
            <FormattedMessage
                defaultMessage="Text to Speech"
                description="Name for the Text to Speech extension"
                id="gui.extension.text2speech.name"
            />
        ),
        extensionId: 'text2speech',
        collaborator: 'Amazon Web Services',
        iconURL: text2speechIconURL,
        insetIconURL: text2speechInsetIconURL,
        description: (
            <FormattedMessage
                defaultMessage="Make your projects talk."
                description="Description for the Text to speech extension"
                id="gui.extension.text2speech.description"
            />
        ),
        tags: ['scratch'],
        featured: true,
        internetConnectionRequired: true
    },
    {
        name: (
            <FormattedMessage
                defaultMessage="Translate"
                description="Name for the Translate extension"
                id="gui.extension.translate.name"
            />
        ),
        extensionId: 'translate',
        collaborator: 'Google',
        iconURL: translateIconURL,
        insetIconURL: translateInsetIconURL,
        description: (
            <FormattedMessage
                defaultMessage="Translate text into many languages."
                description="Description for the Translate extension"
                id="gui.extension.translate.description"
            />
        ),
        tags: ['scratch'],
        featured: true,
        internetConnectionRequired: true
    },
    {
        name: 'Makey Makey',
        extensionId: 'makeymakey',
        collaborator: 'JoyLabz',
        iconURL: makeymakeyIconURL,
        insetIconURL: makeymakeyInsetIconURL,
        description: (
            <FormattedMessage
                defaultMessage="Make anything into a key."
                description="Description for the 'Makey Makey' extension"
                id="gui.extension.makeymakey.description"
            />
        ),
        tags: ['scratch'],
        featured: true
    },
    {
        name: 'micro:bit',
        extensionId: 'microbit',
        collaborator: 'micro:bit',
        iconURL: microbitIconURL,
        insetIconURL: microbitInsetIconURL,
        description: (
            <FormattedMessage
                defaultMessage="Connect your projects with the world."
                description="Description for the 'micro:bit' extension"
                id="gui.extension.microbit.description"
            />
        ),
        tags: ['scratch'],
        featured: true,
        disabled: false,
        bluetoothRequired: true,
        internetConnectionRequired: true,
        launchPeripheralConnectionFlow: true,
        useAutoScan: false,
        connectionIconURL: microbitConnectionIconURL,
        connectionSmallIconURL: microbitConnectionSmallIconURL,
        connectingMessage: (
            <FormattedMessage
                defaultMessage="Connecting"
                description="Message to help people connect to their micro:bit."
                id="gui.extension.microbit.connectingMessage"
            />
        ),
        helpLink: 'https://scratch.mit.edu/microbit'
    },
    {
        name: 'LEGO MINDSTORMS EV3',
        extensionId: 'ev3',
        collaborator: 'LEGO',
        iconURL: ev3IconURL,
        insetIconURL: ev3InsetIconURL,
        description: (
            <FormattedMessage
                defaultMessage="Build interactive robots and more."
                description="Description for the 'LEGO MINDSTORMS EV3' extension"
                id="gui.extension.ev3.description"
            />
        ),
        tags: ['scratch'],
        featured: true,
        disabled: false,
        bluetoothRequired: true,
        internetConnectionRequired: true,
        launchPeripheralConnectionFlow: true,
        useAutoScan: false,
        connectionIconURL: ev3ConnectionIconURL,
        connectionSmallIconURL: ev3ConnectionSmallIconURL,
        connectingMessage: (
            <FormattedMessage
                defaultMessage="Connecting. Make sure the pin on your EV3 is set to 1234."
                description="Message to help people connect to their EV3. Must note the PIN should be 1234."
                id="gui.extension.ev3.connectingMessage"
            />
        ),
        helpLink: 'https://scratch.mit.edu/ev3'
    },
    {
        name: 'LEGO BOOST',
        extensionId: 'boost',
        collaborator: 'LEGO',
        iconURL: boostIconURL,
        insetIconURL: boostInsetIconURL,
        description: (
            <FormattedMessage
                defaultMessage="Bring robotic creations to life."
                description="Description for the 'LEGO BOOST' extension"
                id="gui.extension.boost.description"
            />
        ),
        tags: ['scratch'],
        featured: true,
        disabled: false,
        bluetoothRequired: true,
        internetConnectionRequired: true,
        launchPeripheralConnectionFlow: true,
        useAutoScan: true,
        connectionIconURL: boostConnectionIconURL,
        connectionSmallIconURL: boostConnectionSmallIconURL,
        connectionTipIconURL: boostConnectionTipIconURL,
        connectingMessage: (
            <FormattedMessage
                defaultMessage="Connecting"
                description="Message to help people connect to their BOOST."
                id="gui.extension.boost.connectingMessage"
            />
        ),
        helpLink: 'https://scratch.mit.edu/boost'
    },
    {
        name: 'LEGO Education WeDo 2.0',
        extensionId: 'wedo2',
        collaborator: 'LEGO',
        iconURL: wedo2IconURL,
        insetIconURL: wedo2InsetIconURL,
        description: (
            <FormattedMessage
                defaultMessage="Build with motors and sensors."
                description="Description for the 'LEGO WeDo 2.0' extension"
                id="gui.extension.wedo2.description"
            />
        ),
        tags: ['scratch'],
        featured: true,
        disabled: false,
        bluetoothRequired: true,
        internetConnectionRequired: true,
        launchPeripheralConnectionFlow: true,
        useAutoScan: true,
        connectionIconURL: wedo2ConnectionIconURL,
        connectionSmallIconURL: wedo2ConnectionSmallIconURL,
        connectionTipIconURL: wedo2ConnectionTipIconURL,
        connectingMessage: (
            <FormattedMessage
                defaultMessage="Connecting"
                description="Message to help people connect to their WeDo."
                id="gui.extension.wedo2.connectingMessage"
            />
        ),
        helpLink: 'https://scratch.mit.edu/wedo'
    },
    {
        name: 'Go Direct Force & Acceleration',
        extensionId: 'gdxfor',
        collaborator: 'Vernier',
        iconURL: gdxforIconURL,
        insetIconURL: gdxforInsetIconURL,
        description: (
            <FormattedMessage
                defaultMessage="Sense push, pull, motion, and spin."
                description="Description for the Vernier Go Direct Force and Acceleration sensor extension"
                id="gui.extension.gdxfor.description"
            />
        ),
        tags: ['scratch'],
        featured: true,
        disabled: false,
        bluetoothRequired: true,
        internetConnectionRequired: true,
        launchPeripheralConnectionFlow: true,
        useAutoScan: false,
        connectionIconURL: gdxforConnectionIconURL,
        connectionSmallIconURL: gdxforConnectionSmallIconURL,
        connectingMessage: (
            <FormattedMessage
                defaultMessage="Connecting"
                description="Message to help people connect to their force and acceleration sensor."
                id="gui.extension.gdxfor.connectingMessage"
            />
        ),
        helpLink: 'https://scratch.mit.edu/vernier'
    },
    {
        // not really an extension, but it's easiest to present it as one
        name: (
            <FormattedMessage
                defaultMessage="Custom Reporters"
                description="Name of custom reporters extension"
                id="tw.customReporters.name"
            />
        ),
        extensionId: 'procedures_enable_return',
        iconURL: returnIcon,
        description: (
            <FormattedMessage
                defaultMessage="Allow custom blocks to output values and be used as inputs."
                description="Description of custom reporters extension"
                id="tw.customReporters.description"
            />
        ),
        tags: ['tw'],
        incompatibleWithScratch: true,
        featured: true
    },
    {
        name: (
            <FormattedMessage
                defaultMessage="TurboWarp Blocks"
                description="Name of the strange 'TurboWarp Blocks' extension"
                id="tw.twExtension.name"
                values="TurboWarp"
            />
        ),
        extensionId: 'tw',
        iconURL: twIcon,
        description: (
            <FormattedMessage
                defaultMessage="Weird new blocks."
                description="Description of the strange 'TurboWarp Blocks' extension"
                id="tw.twExtension.description"
            />
        ),
        incompatibleWithScratch: true,
        tags: ['tw'],
        featured: true
    },
    {
        name: (
            <FormattedMessage
                defaultMessage="Custom Extension"
                description="Name of library item to load a custom extension from a remote source"
                id="tw.customExtension.name"
            />
        ),
        extensionId: 'custom_extension',
        iconURL: customExtensionIcon,
        description: (
            <FormattedMessage
                defaultMessage="Load custom extensions from URLs, files, or JavaScript source code."
                description="Description of library item to load a custom extension from a custom source"
                id="tw.customExtension.description"
            />
        ),
        tags: ['tw'],
        featured: true
        // Not marked as incompatible with Scratch so that clicking on it doesn't show a prompt
    }, 
    {
        name: '云',
        extensionId: 'yun',
        iconURL: cloudIconURL,
        // insetIconURL: cloudIconURL,
        description: '云数据',
        tags: ['40code'],
        featured: true
    },
    {
        name: 'Scratch高级设置',
        extensionId: 'set',
        iconURL: twIcon,
        description: '高级设置',
        tags: ['40code'],
        featured: true
    },
    {
        name: '懒加载音乐',
        extensionId: 'lazyAudio',
        iconURL: lazymusicIconURL,
        tags: ['40code'],
        description: '懒加载音乐扩展指令，还有一些音乐高级功能',
        featured: true
    },
    {
        name: (
            <FormattedMessage
                defaultMessage="40code社区"
                description="Name for the 'Community' extension"
                id="gui.extension.community.name"
            />
        ),
        extensionId: 'community2',
        iconURL: _40code,//communityImage,
        tags: ['40code'],
        description: (
            <FormattedMessage
                defaultMessage="Community blocks."
                description="Description for the 'community' extension"
                id="gui.extension.community.description"
            />
        ),
        featured: true
    },
    {
        name: '运算',
        extensionId: 'yx',
        collaborator: '',
        iconURL: ysSmallIconURL,//canvasIconURL,
        tags: ['40code'],
        description: '运算',
        featured: true
    },
    {
        name: 'Canvas',
        extensionId: 'canvas',
        collaborator: '',
        iconURL: canvasIconURL,//canvasIconURL,
        tags: ['40code'],
        description: '高级画布扩展指令',
        featured: true
    },
    {
        name: 'JS扩展',
        extensionId: 'jsonfetch',
        iconURL: jsIconURL,//stringExtImage,
        tags: ['40code'],
        description: 'JS扩展，还有网络请求',
        featured: true
    },
    {
        name: '3D引擎',
        extensionId: 'three',
        iconURL: _3dIconURL,//stringExtImage,
        tags: ['40code'],
        description: '3D引擎',
        featured: true
    },
    {
        name: '3D物理引擎',
        extensionId: 'p3d',
        iconURL: _3dIconURL,//stringExtImage,
        tags: ['40code'],
        description: '3D物理引擎',
        featured: true
    },
    // {
    //     name: '2D物理引擎',
    //     extensionId: 'box2d',
    //     collaborator: 'griffpatch',
    //     iconURL: twIcon,
    //     description: '2D物理引擎(由griffpatch制作，感谢griffpatch)',
    //     tags: ['40code'],
    //     featured: true
    // },
    {
        name: '图层',
        extensionId: 'tc',
        iconURL: twIcon,
        description: '图层设置',
        tags: ['40code'],
        featured: true
    },
    {
        name: '触碰',
        extensionId: 'touch',
        iconURL: twIcon,
        description: '触碰',
        tags: ['40code'],
        featured: true
    },
    // {
    //     name: '其他扩展合集',
    //     extensionId: 'other',
    //     iconURL: twIcon,
    //     description: '其他扩展合集',
    //     tags: ['40code'],
    //     featured: true
    // }
];

export const galleryLoading = {
    name: (
        <FormattedMessage
            defaultMessage="TurboWarp Extension Gallery"
            description="Name of extensions.turbowarp.org in extension library"
            id="tw.extensionGallery.name"
            values="TurboWarp"
        />
    ),
    href: 'https://extensions.turbowarp.org/',
    extensionId: 'gallery',
    iconURL: galleryIcon,
    description: (
        <FormattedMessage
            // eslint-disable-next-line max-len
            defaultMessage="Loading extension gallery..."
            description="Appears while loading extension list from the custom extension gallery"
            id="tw.extensionGallery.loading"
        />
    ),
    tags: ['tw'],
    featured: true
};

export const galleryMore = {
    name: (
        <FormattedMessage
            defaultMessage="TurboWarp Extension Gallery"
            description="Name of extensions.turbowarp.org in extension library"
            id="tw.extensionGallery.name"
            values="TurboWarp"
        />
    ),
    href: 'https://extensions.turbowarp.org/',
    extensionId: 'gallery',
    iconURL: galleryIcon,
    description: (
        <FormattedMessage
            // eslint-disable-next-line max-len
            defaultMessage="Learn more about extensions at extensions.turbowarp.org."
            description="Appears after the extension list from the gallery was loaded successfully"
            id="tw.extensionGallery.more"
        />
    ),
    tags: ['tw'],
    featured: true
};

export const galleryError = {
    name: (
        <FormattedMessage
            defaultMessage="TurboWarp Extension Gallery"
            description="Name of extensions.turbowarp.org in extension library"
            id="tw.extensionGallery.name"
            values="TurboWarp"
        />
    ),
    href: 'https://extensions.turbowarp.org/',
    extensionId: 'gallery',
    iconURL: galleryIcon,
    description: (
        <FormattedMessage
            // eslint-disable-next-line max-len
            defaultMessage="Error loading extension gallery. Visit extensions.turbowarp.org to find more extensions."
            description="Appears when an error occurred loading extension list from the custom extension gallery"
            id="tw.extensionGallery.error"
        />
    ),
    tags: ['tw'],
    featured: true
};
