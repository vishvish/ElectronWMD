import { exec as sudoExec } from 'sudo-prompt';
import { join as pathJoin } from 'path';
import { app } from 'electron';
import { Socket } from 'net';
import { PackrStream, UnpackrStream } from 'msgpackr';
import fs from 'fs';

export function getSocketName(){
    return pathJoin(process.env['TMPDIR'] || '/tmp/', 'ewmd-intermediary.sock');
}

export function startServer(){
    const temp = process.env['TMPDIR'] || '/tmp/';
    
    const socketName = pathJoin(temp, 'ewmd-intermediary.sock');
    const pidFile = pathJoin(temp, 'ewmd-intermediary.pid');
    const canFail = (func: () => void) => {
        try{ func() } catch(_){}
    }
    
    if(fs.existsSync(pidFile)) {
        const oldPid = parseInt(fs.readFileSync(pidFile).toString());
        canFail(() => process.kill(oldPid, 'SIGKILL'));
        canFail(() => fs.unlinkSync(pidFile));
    }
    canFail(() => fs.unlinkSync(socketName));

    const executablePath = app.getPath('exe');
    let serverPath = pathJoin(app.getAppPath(), "dist", "macos", "server.js");
    if(!fs.existsSync(serverPath)) {
        serverPath = pathJoin(app.getAppPath(), "macos", "server.js");
    }
    let envs = "ELECTRON_RUN_AS_NODE=1";
    if(process.env.EWMD_HIMD_BYPASS_COHERENCY_CHECK) {
        envs += ` EWMD_HIMD_BYPASS_COHERENCY_CHECK=${process.env.EWMD_HIMD_BYPASS_COHERENCY_CHECK}`;
    }
    return new Promise<void>((res) => 
        sudoExec(`${envs} "${executablePath}" "${serverPath}" "${app.getPath('userData')}"`, {
            name: "ElectronWMD",
        }, (err, stdout, stderr) => {
            res();
        })
    );
}

export class Connection {
    socket: Socket;
    outStream = new PackrStream();
    
    awaitingReturnName: string | null = null;
    awaitingReturnResolve: ((obj: any) => void) | null = null;
    awaitingReturnReject: ((obj: any) => void) | null = null;

    callbackHandler: ((service: string, name: string, ...args: any[]) => void) | null = null;
    
    deviceDisconnectedCallback?: () => void;

    connect(){
        return new Promise<void>(res => {
            this.socket = new Socket();
            this.outStream = new PackrStream();
            this.socket.on('connect', (err: boolean) => {
                if(err){
                    console.log("Error!");
                    return
                }
                console.log('Connected');

                const unpackerStream = new UnpackrStream();
                this.socket.pipe(unpackerStream);
                this.outStream.pipe(this.socket);
                unpackerStream.on('data', ({ type, name, value, service }: { type: string, name: string, service: string, value: any }) => {
                    if(type === "return"){
                        if(name !== this.awaitingReturnName){
                            console.log(`Mismatch between awaited return and actual (${this.awaitingReturnName} != ${name})`);
                            this.awaitingReturnReject("mismatch");
                        }
                        // value is [out, err]
                        if(value[1]){
                            this.awaitingReturnReject(value[1]);
                        }else{
                            this.awaitingReturnResolve(value[0]);
                        }
                    }else if(type === "callback"){
                        this.callbackHandler?.(service, name, ...value);
                    }
                });
                if(this.deviceDisconnectedCallback) {
                    this.socket.on('close', this.deviceDisconnectedCallback);
                }
                res();
            });
            this.socket.connect(getSocketName());
        });
    }

    private earlyTerminate = false;

    terminateAwaitConnection(){
        this.earlyTerminate = true;
    }

    async awaitConnection(){
        this.socket = null;
        this.earlyTerminate = false;
        console.log("Waiting for server to start...");
        await new Promise<void>(res => {
            let interval = setInterval(() => {
                try{
                    if(this.earlyTerminate || fs.statSync(getSocketName()).isSocket()){
                        clearInterval(interval);
                        res();
                        return;
                    }
                }catch(ex){
                    //pass
                }
            }, 500);
        });
        if(this.earlyTerminate) {
            return new Error("Couldn't bring up the server!");
        }
        try{
            await this.connect();
        }catch(ex){
            this.socket = null;
            console.log(ex);
            return ex;
        }
        return null;
    }

    disconnect(){
        this.socket.removeAllListeners('close');
        this.socket.destroy();
    }

    callMethod(service: string, name: string, ...allArgs: any[]): Promise<any>{
        return new Promise((res, rej) => {
            for (let i = 0; i < allArgs.length; i++) {
                if (typeof allArgs[i] === 'function') {
                    allArgs[i] = { interprocessType: 'function' };
                }
            }

            this.awaitingReturnName = name;
            this.awaitingReturnResolve = res;
            this.awaitingReturnReject = rej;
            this.outStream.write({
                service, name, allArgs
            })
        });
    }
}