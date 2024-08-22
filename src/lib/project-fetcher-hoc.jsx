import React from 'react';
import PropTypes from 'prop-types';
import { intlShape, injectIntl } from 'react-intl';
import bindAll from 'lodash.bindall';
import { connect } from 'react-redux';

import { setProjectUnchanged } from '../reducers/project-changed';
import {
    LoadingStates,
    getIsCreatingNew,
    getIsFetchingWithId,
    getIsLoading,
    getIsShowingProject,
    onFetchedProjectData,
    projectError,
    setProjectId
} from '../reducers/project-state';
import {
    activateTab,
    BLOCKS_TAB_INDEX
} from '../reducers/editor-tab';

import log from './log';
import storage from './storage';

import VM from 'scratch-vm';
import { fetchProjectMeta } from './tw-project-meta-fetcher-hoc.jsx';

// TW: Temporary hack for project tokens
const fetchProjectToken = async projectId => {
    if (projectId === '0') {
        return null;
    }
    // Parse ?token=abcdef
    const searchParams = new URLSearchParams(location.search);
    if (searchParams.has('token')) {
        return searchParams.get('token');
    }
    // Parse #1?token=abcdef
    const hashParams = new URLSearchParams(location.hash.split('?')[1]);
    if (hashParams.has('token')) {
        return hashParams.get('token');
    }
    try {
        const metadata = await fetchProjectMeta(projectId);
        return metadata.project_token;
    } catch (e) {
        log.error(e);
        throw new Error('Cannot access project token. Project is probably unshared. See https://docs.turbowarp.org/unshared-projects');
    }
};

/* Higher Order Component to provide behavior for loading projects by id. If
 * there's no id, the default project is loaded.
 * @param {React.Component} WrappedComponent component to receive projectData prop
 * @returns {React.Component} component with project loading behavior
 */
const ProjectFetcherHOC = function (WrappedComponent) {
    class ProjectFetcherComponent extends React.Component {
        constructor(props) {
            super(props);
            bindAll(this, [
                'fetchProject'
            ]);
            storage.setProjectHost(props.projectHost);
            storage.setProjectToken(props.projectToken);
            storage.setAssetHost(props.assetHost);
            storage.setTranslatorFunction(props.intl.formatMessage);
            // props.projectId might be unset, in which case we use our default;
            // or it may be set by an even higher HOC, and passed to us.
            // Either way, we now know what the initial projectId should be, so
            // set it in the redux store.
            if (
                props.projectId !== '' &&
                props.projectId !== null &&
                typeof props.projectId !== 'undefined'
            ) {
                this.props.setProjectId(props.projectId.toString());
            }
        }
        componentDidUpdate(prevProps) {
            if (prevProps.projectHost !== this.props.projectHost) {
                storage.setProjectHost(this.props.projectHost);
            }
            if (prevProps.projectToken !== this.props.projectToken) {
                storage.setProjectToken(this.props.projectToken);
            }
            if (prevProps.assetHost !== this.props.assetHost) {
                storage.setAssetHost(this.props.assetHost);
            }
            if (this.props.isFetchingWithId && !prevProps.isFetchingWithId) {
                const that = this;
                if(window.isElectron){
                    fetch('../other/1.sb3').then(r => r.blob()).then(blob => {
                        const reader = new FileReader();
                        reader.onload = () => {
                            that.props.onFetchedProjectData(reader.result, that.props.loadingState);
                        };
                        reader.readAsArrayBuffer(blob);
                    })
                    $('#ch').remove()
                    return
                }
                var d;
                
                function Decrypt(word) {
                    const k0 = ["9609274736591562", '4312549111852919']
                    const key = CryptoJS.enc.Utf8.parse(k0[0]);  //十六位十六进制数作为密钥
                    const iv = CryptoJS.enc.Utf8.parse(k0[1]);   //十六位十六进制数作为密钥偏移量
                    let encryptedHexStr = CryptoJS.enc.Hex.parse(word);
                    let srcs = CryptoJS.enc.Base64.stringify(encryptedHexStr);
                    let decrypt = CryptoJS.AES.decrypt(srcs, key, { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
                    let decryptedStr = decrypt.toString(CryptoJS.enc.Utf8);
                    return decryptedStr.toString();
                }
                (async () => {
                    try {
                        try {
                            d = workinfo;
                        } catch (error) {
                            window.workinfo = d = await getworkinfosync(id);
                            getuserinfo();
                        }
                        if (location.pathname.indexOf('editor.html') != -1) {
                            if (d === undefined) {
                                alert("未知错误")
                                $(document).text("未知错误")
                                throw ('未知错误')
                            }
                            if (!d.issign) {
                                alert("请登录后查看")
                                $(document).text("请登录后查看")
                                location.href = "/#page=sign"
                                throw ("请登录后查看")
                            }
                            if (!(d.isauthor || (d.opensource && d.publish))) {
                                alert("你没有权限，当前作品未开源或未发布")
                                $(document).text("你没有权限，当前作品未开源或未发布")
                                throw ("你没有权限，当前作品未开源或未发布")
                            }
                            $('#save').click(() => {
                                window.save()
                            })
                            $('#publish').click(() => {
                                window.save(1)
                            })
                            if (d.isauthor) {
                                $('#setCover').click(() => {
                                    savecover(function (id) {
                                        post({
                                            url: 'work/info/update',
                                            data: { id: workinfo.id, image: id, coveronly: 1 },
                                            p: 'updatework'
                                        }, function (d) {
                                            console.log(d)
                                        })
                                    })
                                })
                            } else {
                                $('#publish').remove()
                                $('#save').text('改编')

                            }
                            // location.href = "#id=" + d.id + (v ? '&v=' + v : '')
                        }
                        // let that=this;
                        // fetch().then(blob => {
                        //     const reader = new FileReader();
                        //     reader.onload = () => {
                        //         that.props.onFetchedProjectData(reader.result, that.props.loadingState);
                        //     };
                        //     reader.readAsArrayBuffer(blob);
                        // });
                        if (d.onlyFirefox && navigator.userAgent.indexOf("Firefox") == -1) {
                            alert('当前作品仅支持Firefox（火狐）浏览器打开，请切换至火狐浏览器')
                            throw new Error('仅支持Firefox')
                        }
                        var toLogin = () => {
                            if (location.hash.startsWith('#page=sign&url='))
                                location.href = '/' + location.hash
                        }
                        toLogin()
                        window.onhashchange = toLogin
                        fetch('https://service-dq726wx5-1302921490.sh.apigw.tencentcs.com/work/work?id=' + id + '&token=' + getCookie('token')
                            + '&sha=' + getQueryString('sha')
                            + '&etime=' + getQueryString('etime')
                            + (v ? '&v=' + v : '')
                        ).then(r => r.blob()).then(blob => {

                            const reader = new FileReader();
                            reader.onload = () => {
                                let result = reader.result
                                if (!d.raw && reader.result[0] != '{')
                                    result = Decrypt(result)
                                result=result.replaceAll('"opcode":"procedures_call_with_return"','"opcode":"procedures_call"')
                                that.props.onFetchedProjectData(result, that.props.loadingState);
                                setTimeout(() => {
                                    location.href = "#id=" + id + (v ? '&v=' + v : '')
                                }, 1000);
                            };
                            if (d.raw)
                                reader.readAsArrayBuffer(blob);
                            else
                                reader.readAsText(blob);
                        }).catch(e => {
                            console.log(e)
                            fetch('https://abc.520gxx.com/p.sb3').then(r => r.blob()).then(blob => {
                                const reader = new FileReader();
                                reader.onload = () => {
                                    that.props.onFetchedProjectData(reader.result, that.props.loadingState);
                                };
                                reader.readAsArrayBuffer(blob);
                            })
                        });
                    } catch (error) {
                        console.log(error)
                        this.fetchProject(this.props.reduxProjectId, this.props.loadingState);
                        alert('作品加载失败')

                    }
                })()
            }
            if (this.props.isShowingProject && !prevProps.isShowingProject) {
                this.props.onProjectUnchanged();
            }
            if (this.props.isShowingProject && (prevProps.isLoadingProject || prevProps.isCreatingNew)) {
                this.props.onActivateTab(BLOCKS_TAB_INDEX);
            }
        }
        fetchProject(projectId, loadingState) {
            // tw: clear and stop the VM before fetching
            // these will also happen later after the project is fetched, but fetching may take a while and
            // the project shouldn't be running while fetching the new project
            this.props.vm.clear();
            this.props.vm.quit();

            let assetPromise;
            // In case running in node...
            let projectUrl = typeof URLSearchParams === 'undefined' ?
                null :
                new URLSearchParams(location.search).get('project_url');
            if (projectUrl) {
                if (!projectUrl.startsWith('http:') && !projectUrl.startsWith('https:')) {
                    projectUrl = `https://${projectUrl}`;
                }
                assetPromise = fetch(projectUrl)
                    .then(r => {
                        if (!r.ok) {
                            throw new Error(`Request returned status ${r.status}`);
                        }
                        return r.arrayBuffer();
                    })
                    .then(buffer => ({ data: buffer }));
            } else {
                // TW: Temporary hack for project tokens
                assetPromise = fetchProjectToken(projectId)
                    .then(token => {
                        storage.setProjectToken(token);
                        return storage.load(storage.AssetType.Project, projectId, storage.DataFormat.JSON);
                    });
            }

            return assetPromise
                .then(projectAsset => {
                    if (projectAsset) {
                        this.props.onFetchedProjectData(projectAsset.data, loadingState);
                    } else {
                        // Treat failure to load as an error
                        // Throw to be caught by catch later on
                        throw new Error('Could not find project');
                    }
                })
                .catch(err => {
                    this.props.onError(err);
                    log.error(err);
                });
        }
        render() {
            const {
                /* eslint-disable no-unused-vars */
                assetHost,
                intl,
                isLoadingProject: isLoadingProjectProp,
                loadingState,
                onActivateTab,
                onError: onErrorProp,
                onFetchedProjectData: onFetchedProjectDataProp,
                onProjectUnchanged,
                projectHost,
                projectId,
                reduxProjectId,
                setProjectId: setProjectIdProp,
                /* eslint-enable no-unused-vars */
                isFetchingWithId: isFetchingWithIdProp,
                ...componentProps
            } = this.props;
            return (
                <WrappedComponent
                    fetchingProject={isFetchingWithIdProp}
                    {...componentProps}
                />
            );
        }
    }
    ProjectFetcherComponent.propTypes = {
        assetHost: PropTypes.string,
        canSave: PropTypes.bool,
        intl: intlShape.isRequired,
        isCreatingNew: PropTypes.bool,
        isFetchingWithId: PropTypes.bool,
        isLoadingProject: PropTypes.bool,
        isShowingProject: PropTypes.bool,
        loadingState: PropTypes.oneOf(LoadingStates),
        onActivateTab: PropTypes.func,
        onError: PropTypes.func,
        onFetchedProjectData: PropTypes.func,
        onProjectUnchanged: PropTypes.func,
        projectHost: PropTypes.string,
        projectToken: PropTypes.string,
        projectId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
        reduxProjectId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
        setProjectId: PropTypes.func,
        vm: PropTypes.instanceOf(VM)
    };
    ProjectFetcherComponent.defaultProps = {
        assetHost: window.scratchhost + '/static',
        projectHost: 'https://projects.scratch.mit.edu'
    };

    const mapStateToProps = state => ({
        isCreatingNew: getIsCreatingNew(state.scratchGui.projectState.loadingState),
        isFetchingWithId: getIsFetchingWithId(state.scratchGui.projectState.loadingState),
        isLoadingProject: getIsLoading(state.scratchGui.projectState.loadingState),
        isShowingProject: getIsShowingProject(state.scratchGui.projectState.loadingState),
        loadingState: state.scratchGui.projectState.loadingState,
        reduxProjectId: state.scratchGui.projectState.projectId,
        vm: state.scratchGui.vm
    });
    const mapDispatchToProps = dispatch => ({
        onActivateTab: tab => dispatch(activateTab(tab)),
        onError: error => dispatch(projectError(error)),
        onFetchedProjectData: (projectData, loadingState) =>
            dispatch(onFetchedProjectData(projectData, loadingState)),
        setProjectId: projectId => dispatch(setProjectId(projectId)),
        onProjectUnchanged: () => dispatch(setProjectUnchanged())
    });
    // Allow incoming props to override redux-provided props. Used to mock in tests.
    const mergeProps = (stateProps, dispatchProps, ownProps) => Object.assign(
        {}, stateProps, dispatchProps, ownProps
    );
    return injectIntl(connect(
        mapStateToProps,
        mapDispatchToProps,
        mergeProps
    )(ProjectFetcherComponent));
};

export {
    ProjectFetcherHOC as default
};
