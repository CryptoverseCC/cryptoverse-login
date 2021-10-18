use tonic::{transport::Server, Request, Response, Status};

use restrictions::verifier_server::{Verifier, VerifierServer};
use restrictions::{VerifyReply, VerifyRequest};

pub mod restrictions {
    tonic::include_proto!("restrictions");
}

#[derive(Debug, Default)]
pub struct RestrictionsVerifier {}

#[tonic::async_trait]
impl Verifier for RestrictionsVerifier {
    async fn verify(
        &self,
        request: Request<VerifyRequest>,
    ) -> Result<Response<VerifyReply>, Status> {
        println!("Got a request: {:?}", request);

        let reply = restrictions::VerifyReply { allowed: false };

        Ok(Response::new(reply))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = "[::1]:50051".parse()?;
    let verifier = RestrictionsVerifier::default();

    Server::builder()
        .add_service(VerifierServer::new(verifier))
        .serve(addr)
        .await?;

    Ok(())
}
