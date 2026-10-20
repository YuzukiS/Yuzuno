//! Isolated, no-model acceptance host for local jobs. Never opens daily data.
use anyhow::{Context, Result};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use yuzuno_workspace::{collaboration_mcp, model::AgentDetail, server, workspace::Workspace};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let root = PathBuf::from(std::env::args().nth(1).context("lab directory required")?);
    let port: u16 = std::env::args()
        .nth(2)
        .context("independent port required")?
        .parse()?;
    anyhow::ensure!(
        (4400..=4999).contains(&port)
            && root.is_absolute()
            && root.to_string_lossy().contains("/target/t47/lab-"),
        "Only independent target/t47/lab-* directories and ports 4400..4999 are allowed"
    );
    std::fs::create_dir_all(&root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
    }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let native = root.join("native.py");
    std::fs::write(
        &native,
        r#"#!/usr/bin/python3
import json,sys,pathlib,threading,time
root=pathlib.Path(__file__).parent
lock=threading.Lock()
def emit(value):
 with lock: print(json.dumps(value),flush=True)
def complete(turn):
 time.sleep(1)
 emit({'method':'turn/completed','params':{'turn':{'id':turn,'status':'completed','items':[]}}})
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r:continue
 m=r.get('method');p=r.get('params',{});result={}
 if m in ['thread/start','thread/resume']:
  result={'thread':{'id':'lab-thread','status':{'type':'idle'},'turns':[]}}
 if m=='turn/start':
  turn='lab-turn-'+str(time.time_ns())
  with (root/'native-starts.jsonl').open('a') as f:f.write(json.dumps(p)+'\n')
  result={'turn':{'id':turn,'status':'inProgress','items':[]}}
  threading.Thread(target=complete,args=(turn,),daemon=True).start()
 emit({'id':r['id'],'result':result})
"#,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o700))?;
    }
    let data = root.join("data");
    let cwd = root.join("work");
    std::fs::create_dir_all(&cwd)?;
    let ws = Workspace::new(
        data,
        cwd.to_string_lossy().into(),
        native.to_string_lossy().into(),
    )?;
    for (id, name) in [("lab-a", "Mori"), ("lab-b", "Hana")] {
        if ws.store.listed_agent(id).is_none() {
            let detail: AgentDetail = serde_json::from_value(
                json!({"agent":{"id":id,"name":name,"cwd":cwd,"model":"fixture","color":"sage","status":"offline","createdAt":"2026-10-15","updatedAt":"2026-10-15","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]}),
            )?;
            ws.store.insert(&detail)?;
        }
    }
    ws.store.collaboration_call(
        None,
        "task_create",
        json!({"requestId":"lab-task","title":"Validate bounded local jobs","status":"doing"}),
    )?;
    let app = server::router_on_port(Arc::clone(&ws), root.parent().unwrap().join("ui"), port);
    let config =
        collaboration_mcp::agent_http_config(&ws, "lab-a", &format!("http://127.0.0.1:{port}"))?;
    std::fs::write(root.join("connection.json"), serde_json::to_vec(&config)?)?;
    axum::serve(listener, app).await?;
    Ok(())
}
