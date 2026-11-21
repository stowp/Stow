//! Threshold-approved withdrawals from a group's pooled balance.

use soroban_sdk::{Address, Env, Vec};

use crate::admin::require_not_paused;
use crate::error::Error;
use crate::events::{
    TOPIC_GROUP_WITHDRAWAL_APPROVED, TOPIC_GROUP_WITHDRAWAL_EXECUTED,
    TOPIC_GROUP_WITHDRAWAL_REJECTED, TOPIC_GROUP_WITHDRAWAL_REQUESTED,
};
use crate::storage::{self, extend_instance_ttl};
use crate::types::{DataKey, Group, GroupWithdrawalRequest};

const MAX_REQUEST_LIFETIME_SECONDS: u64 = 30 * 86_400;

/// Create a withdrawal request against a closed group.
///
/// The approver set is snapshotted from group membership. The requester does
/// not count as an approver unless they separately call `approve`.
pub fn request_withdrawal(
    env: &Env,
    requester: Address,
    group_id: u64,
    recipient: Address,
    amount: i128,
    threshold: u32,
    expires_at: u64,
) -> Result<u64, Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    requester.require_auth();

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let group_key = DataKey::Group(group_id);
    let group: Group = env
        .storage()
        .persistent()
        .get(&group_key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &group_key);

    if !group.members.iter().any(|member| member == requester) {
        return Err(Error::NotAMember);
    }
    if group.open {
        return Err(Error::GroupClosed);
    }
    if amount > group.balance {
        return Err(Error::InsufficientGroupFunds);
    }

    let now = env.ledger().timestamp();
    let max_expiration = now
        .checked_add(MAX_REQUEST_LIFETIME_SECONDS)
        .ok_or(Error::Overflow)?;
    if threshold == 0
        || threshold as u64 > group.members.len() as u64
        || expires_at <= now
        || expires_at > max_expiration
    {
        return Err(Error::InvalidParameters);
    }

    let id = storage::next_id(env, DataKey::NextGroupWithdrawalId);
    let request = GroupWithdrawalRequest {
        id,
        group_id,
        requester: requester.clone(),
        recipient: recipient.clone(),
        amount,
        threshold,
        approvers: Vec::new(env),
        expires_at,
        rejected: false,
        executed: false,
    };
    let request_key = DataKey::GroupWithdrawal(id);
    env.storage().persistent().set(&request_key, &request);
    storage::extend_persistent_ttl(env, &request_key);

    env.events().publish(
        (TOPIC_GROUP_WITHDRAWAL_REQUESTED, requester.clone(), id),
        (
            id,
            group_id,
            requester,
            recipient,
            amount,
            threshold,
            expires_at,
            now,
        ),
    );
    Ok(id)
}

/// Record a group member's approval. When the request reaches its threshold,
/// the withdrawal is paid atomically to the recorded recipient.
pub fn approve_withdrawal(
    env: &Env,
    approver: Address,
    request_id: u64,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    approver.require_auth();

    let request_key = DataKey::GroupWithdrawal(request_id);
    let mut request: GroupWithdrawalRequest = env
        .storage()
        .persistent()
        .get(&request_key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &request_key);
    ensure_pending(env, &request)?;

    let group_key = DataKey::Group(request.group_id);
    let group: Group = env
        .storage()
        .persistent()
        .get(&group_key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &group_key);

    if !group.members.iter().any(|member| member == approver) {
        return Err(Error::Unauthorized);
    }
    if request.approvers.iter().any(|approved| approved == approver) {
        return Err(Error::AlreadyVoted);
    }

    request.approvers.push_back(approver.clone());
    env.events().publish(
        (TOPIC_GROUP_WITHDRAWAL_APPROVED, approver.clone(), request_id),
        (
            request_id,
            request.group_id,
            approver,
            request.approvers.len(),
            request.threshold,
            env.ledger().timestamp(),
        ),
    );

    if request.approvers.len() >= request.threshold {
        if request.amount > group.balance {
            return Err(Error::InsufficientGroupFunds);
        }
        let new_balance = group
            .balance
            .checked_sub(request.amount)
            .ok_or(Error::Overflow)?;
        storage::transfer_out(env, &request.recipient, request.amount)?;
        request.executed = true;
        let mut group = group;
        group.balance = new_balance;
        env.storage().persistent().set(&group_key, &group);
        storage::extend_persistent_ttl(env, &group_key);
        env.events().publish(
            (TOPIC_GROUP_WITHDRAWAL_EXECUTED, request_id),
            (
                request_id,
                request.group_id,
                request.recipient.clone(),
                request.amount,
                env.ledger().timestamp(),
            ),
        );
    }

    env.storage().persistent().set(&request_key, &request);
    storage::extend_persistent_ttl(env, &request_key);
    Ok(())
}

/// Reject and cancel a pending withdrawal. Any current group member may veto.
pub fn reject_withdrawal(
    env: &Env,
    rejector: Address,
    request_id: u64,
) -> Result<(), Error> {
    extend_instance_ttl(env);
    require_not_paused(env)?;
    rejector.require_auth();

    let request_key = DataKey::GroupWithdrawal(request_id);
    let mut request: GroupWithdrawalRequest = env
        .storage()
        .persistent()
        .get(&request_key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &request_key);
    ensure_pending(env, &request)?;

    let group_key = DataKey::Group(request.group_id);
    let group: Group = env
        .storage()
        .persistent()
        .get(&group_key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &group_key);
    if !group.members.iter().any(|member| member == rejector) {
        return Err(Error::Unauthorized);
    }

    request.rejected = true;
    env.storage().persistent().set(&request_key, &request);
    storage::extend_persistent_ttl(env, &request_key);
    env.events().publish(
        (TOPIC_GROUP_WITHDRAWAL_REJECTED, rejector.clone(), request_id),
        (
            request_id,
            request.group_id,
            rejector,
            env.ledger().timestamp(),
        ),
    );
    Ok(())
}

/// Read a withdrawal request, including its current approval list.
pub fn get_withdrawal_request(
    env: &Env,
    request_id: u64,
) -> Result<GroupWithdrawalRequest, Error> {
    let key = DataKey::GroupWithdrawal(request_id);
    let request = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    storage::extend_persistent_ttl(env, &key);
    Ok(request)
}

fn ensure_pending(env: &Env, request: &GroupWithdrawalRequest) -> Result<(), Error> {
    if request.rejected || request.executed {
        return Err(Error::WithdrawalRequestClosed);
    }
    if env.ledger().timestamp() >= request.expires_at {
        return Err(Error::OperationExpired);
    }
    Ok(())
}
